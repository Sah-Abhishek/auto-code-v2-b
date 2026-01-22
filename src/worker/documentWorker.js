/**
 * Document Processing Worker
 * 
 * Run this as a separate process: node workers/documentWorker.js
 * 
 * This worker:
 * 1. Polls the processing_queue table for pending jobs
 * 2. Claims a job using FOR UPDATE SKIP LOCKED (safe for multiple workers)
 * 3. Downloads files from S3, runs OCR, runs AI analysis
 * 4. Updates the chart with results
 * 5. Marks the job as completed
 * 
 * UPDATED: 
 * - Properly updates chart status on failure (retry_pending vs failed)
 * - Supports exponential backoff via QueueService
 * - Better error tracking and logging
 */

import { QueueService } from '../db/queueService.js';
import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { ocrService } from '../services/ocrService.js';
import { aiService } from '../services/aiService.js';
import { createSLATracker } from '../utils/slaTracker.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

class DocumentWorker {
  constructor() {
    this.workerId = `worker-${os.hostname()}-${process.pid}`;
    this.isRunning = false;
    this.pollInterval = 2000; // Check for new jobs every 2 seconds
    this.shutdownRequested = false;
  }

  /**
   * Start the worker
   */
  async start() {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[WORKER STARTED] ID: ${this.workerId}`);
    console.log(`${'═'.repeat(60)}\n`);

    this.isRunning = true;

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Release any stuck jobs from crashed workers
    const stuckJobs = await QueueService.releaseStuckJobs(30);
    if (stuckJobs.length > 0) {
      console.log(`🔓 Released ${stuckJobs.length} stuck jobs on startup`);
    }

    // Main processing loop
    while (this.isRunning) {
      try {
        await this.processNextJob();
      } catch (error) {
        console.error(`[WORKER ERROR] ${error.message}`);
        // Wait a bit longer on errors
        await this.sleep(5000);
      }

      // Wait before checking for next job
      if (this.isRunning) {
        await this.sleep(this.pollInterval);
      }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('[WORKER STOPPED]');
    console.log(`${'═'.repeat(60)}\n`);
  }

  /**
   * Process the next available job
   */
  async processNextJob() {
    // Try to claim a job
    const job = await QueueService.claimNextJob(this.workerId);

    if (!job) {
      // No jobs available, that's fine
      return;
    }

    const sla = createSLATracker();
    sla.markUploadReceived();

    let jobData;
    try {
      jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
    } catch (e) {
      console.error(`[JOB ERROR] Failed to parse job data for ${job.job_id}`);
      await this.handleJobFailure(job, 'Invalid job data format');
      return;
    }

    const { chartId, chartNumber, chartInfo, documents } = jobData;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`[PROCESSING] Chart: ${chartNumber} | Attempt: ${job.attempts}/${job.max_attempts}`);
    console.log(`${'─'.repeat(50)}`);

    try {
      // Update chart status to processing
      await ChartRepository.updateStatus(chartNumber, 'processing');

      // PHASE 1: OCR Processing
      sla.markOCRStarted();
      console.log(`\n[PHASE 1] OCR Processing - ${documents.length} document(s)`);

      const ocrResults = [];

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        console.log(`  Processing ${i + 1}/${documents.length}: ${doc.originalName}`);

        // OCR Processing - download from S3 and process
        const ocrResult = await this.performOCR(doc);

        if (ocrResult.success) {
          // Update document with OCR text
          await DocumentRepository.updateOCRResults(
            doc.documentId,
            typeof ocrResult.extractedText === 'string'
              ? ocrResult.extractedText
              : JSON.stringify(ocrResult.extractedText),
            ocrResult.processingTime
          );

          ocrResults.push({
            ...ocrResult,
            documentId: doc.documentId,
            s3Url: doc.s3Url,
            filename: doc.originalName,
            documentType: doc.documentType
          });

          console.log(`  ✓ OCR Success: ${doc.originalName} (${ocrResult.processingTime}ms)`);
        } else {
          // Mark document as failed
          await DocumentRepository.markOCRFailed(doc.documentId, ocrResult.error);

          ocrResults.push({
            success: false,
            documentId: doc.documentId,
            s3Url: doc.s3Url,
            filename: doc.originalName,
            documentType: doc.documentType,
            error: ocrResult.error
          });

          console.log(`  ✗ OCR Failed: ${doc.originalName} - ${ocrResult.error}`);
        }
      }

      sla.markOCRCompleted();

      const successfulOCR = ocrResults.filter(r => r.success);

      if (successfulOCR.length === 0) {
        throw new Error('All OCR processing failed - no text extracted from any document');
      }

      console.log(`  OCR Complete: ${successfulOCR.length}/${documents.length} successful`);

      // PHASE 2: AI Coding Analysis
      sla.markAIStarted();
      console.log(`\n[PHASE 2] AI Coding Analysis`);

      const formattedDocs = ocrService.formatForAI(ocrResults);
      console.log(`  Sending ${formattedDocs.length} document(s) to AI...`);

      const aiResult = await aiService.processForCoding(formattedDocs, chartInfo);

      sla.markAICompleted();

      if (!aiResult.success) {
        throw new Error(`AI processing failed: ${aiResult.error}`);
      }

      console.log(`  ✓ AI Analysis Complete`);

      // PHASE 3: Generate Document Summaries
      console.log(`\n[PHASE 3] Generating Document Summaries`);
      let summaryCount = 0;

      for (const ocrResult of successfulOCR) {
        try {
          const docSummary = await aiService.generateDocumentSummary(ocrResult, chartInfo);
          if (docSummary.success) {
            await DocumentRepository.updateAISummary(ocrResult.documentId, docSummary.data);
            summaryCount++;
          }
        } catch (error) {
          // Summary generation failed - continue with others
          console.log(`  ⚠ Summary failed for ${ocrResult.filename}: ${error.message}`);
        }
      }

      console.log(`  Generated ${summaryCount}/${successfulOCR.length} summaries`);

      sla.markComplete();
      const slaSummary = sla.getSummary();

      // Update chart with AI results (clears any previous error state)
      await ChartRepository.updateWithAIResults(chartNumber, aiResult.data, slaSummary);

      // Mark job as completed
      await QueueService.completeJob(job.job_id);

      console.log(`\n${'─'.repeat(50)}`);
      console.log(`[✓ COMPLETED] Chart: ${chartNumber}`);
      console.log(`  Duration: ${slaSummary.durations.total} | SLA: ${slaSummary.slaStatus.status}`);
      console.log(`${'─'.repeat(50)}\n`);

    } catch (error) {
      console.error(`\n[✗ FAILED] Chart: ${chartNumber}`);
      console.error(`  Error: ${error.message}`);

      await this.handleJobFailure(job, error.message, chartNumber);
    }
  }

  /**
   * Handle job failure with proper status updates
   */
  async handleJobFailure(job, errorMessage, chartNumber = null) {
    // Mark job as failed (QueueService handles retry scheduling)
    const failResult = await QueueService.failJob(job.job_id, errorMessage);

    if (!failResult) {
      console.error(`  Could not update job status`);
      return;
    }

    // Get chartNumber from job if not provided
    if (!chartNumber) {
      try {
        const jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
        chartNumber = jobData.chartNumber;
      } catch (e) {
        console.error(`  Could not extract chartNumber from job`);
        return;
      }
    }

    // Update chart status based on whether it will retry
    if (failResult.isPermanentlyFailed) {
      // Permanently failed - no more retries
      await ChartRepository.markFailed(chartNumber, errorMessage);
      console.log(`  Chart marked as FAILED (max attempts reached)`);
    } else {
      // Will retry - set to retry_pending
      await ChartRepository.updateWithError(
        chartNumber,
        errorMessage,
        true,
        failResult.attempts
      );

      const retryInSeconds = Math.round((failResult.retryAfter - new Date()) / 1000);
      console.log(`  Chart marked as RETRY_PENDING (retry in ${retryInSeconds}s)`);
    }

    console.log(`${'─'.repeat(50)}\n`);
  }

  /**
   * Perform OCR on a document (downloads from S3, runs OCR)
   */
  async performOCR(doc) {
    const startTime = Date.now();
    let tempPath = null;

    try {
      // Download file from S3 to temp location
      const response = await axios.get(doc.s3Url, {
        responseType: 'arraybuffer',
        timeout: 60000 // 60 second timeout
      });

      // Create temp file
      const tempDir = os.tmpdir();
      const safeFilename = doc.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempPath = path.join(tempDir, `ocr_${Date.now()}_${safeFilename}`);
      fs.writeFileSync(tempPath, response.data);

      // Create file object for OCR service
      const tempFile = {
        path: tempPath,
        originalname: doc.originalName,
        mimetype: doc.mimeType
      };

      // Run OCR
      const ocrResult = await ocrService.extractText(tempFile, doc.documentType);

      return ocrResult;

    } catch (error) {
      return {
        success: false,
        filename: doc.originalName,
        documentType: doc.documentType,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    } finally {
      // Cleanup temp file
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    if (this.shutdownRequested) return;

    console.log('\n[SHUTDOWN REQUESTED] Finishing current job...');
    this.shutdownRequested = true;
    this.isRunning = false;
  }
}

// Run the worker if this file is executed directly
const worker = new DocumentWorker();
worker.start().catch(error => {
  console.error('Fatal worker error:', error);
  process.exit(1);
});

export default DocumentWorker;
