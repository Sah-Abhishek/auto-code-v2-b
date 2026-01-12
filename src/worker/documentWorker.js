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
    console.log('\n' + '═'.repeat(60));
    console.log(`🚀 Document Processing Worker Started`);
    console.log(`   Worker ID: ${this.workerId}`);
    console.log(`   Poll Interval: ${this.pollInterval}ms`);
    console.log('═'.repeat(60) + '\n');

    this.isRunning = true;

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Release any stuck jobs from crashed workers
    await QueueService.releaseStuckJobs(30);

    // Main processing loop
    while (this.isRunning) {
      try {
        await this.processNextJob();
      } catch (error) {
        console.error('❌ Worker error:', error.message);
      }

      // Wait before checking for next job
      if (this.isRunning) {
        await this.sleep(this.pollInterval);
      }
    }

    console.log('👋 Worker stopped gracefully');
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

    console.log('\n' + '─'.repeat(60));
    console.log(`📦 Processing Job: ${job.job_id}`);
    console.log(`   Chart: ${job.chart_number} | Attempt: ${job.attempts}/${job.max_attempts}`);
    console.log('─'.repeat(60));

    const sla = createSLATracker();
    sla.markUploadReceived();

    try {
      const jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
      const { chartId, chartNumber, chartInfo, documents } = jobData;

      // Update chart status to processing
      await ChartRepository.updateStatus(chartNumber, 'processing');

      // ═══════════════════════════════════════════════════════════════
      // PHASE 1: OCR Processing
      // ═══════════════════════════════════════════════════════════════
      console.log('\n🔍 PHASE 1: OCR PROCESSING');
      sla.markOCRStarted();

      const ocrResults = [];

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        console.log(`   [${i + 1}/${documents.length}] Processing ${doc.originalName}...`);

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

          console.log(`   ✅ OCR completed: ${doc.originalName} (${ocrResult.processingTime}ms)`);
        } else {
          console.log(`   ⚠️ OCR failed: ${doc.originalName} - ${ocrResult.error}`);

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
        }
      }

      sla.markOCRCompleted();

      const successfulOCR = ocrResults.filter(r => r.success);
      console.log(`   📊 OCR Complete: ${successfulOCR.length}/${ocrResults.length} files successful`);

      if (successfulOCR.length === 0) {
        throw new Error('All OCR processing failed');
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: AI Coding Analysis
      // ═══════════════════════════════════════════════════════════════
      console.log('\n🤖 PHASE 2: AI CODING ANALYSIS');
      sla.markAIStarted();

      const formattedDocs = ocrService.formatForAI(ocrResults);
      const aiResult = await aiService.processForCoding(formattedDocs, chartInfo);

      sla.markAICompleted();

      if (!aiResult.success) {
        throw new Error(`AI processing failed: ${aiResult.error}`);
      }

      console.log(`   ✅ AI analysis complete`);

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: Generate Document Summaries
      // ═══════════════════════════════════════════════════════════════
      console.log('\n📝 PHASE 3: DOCUMENT SUMMARIES');

      for (const ocrResult of successfulOCR) {
        try {
          const docSummary = await aiService.generateDocumentSummary(ocrResult, chartInfo);
          if (docSummary.success) {
            await DocumentRepository.updateAISummary(ocrResult.documentId, docSummary.data);
            console.log(`   ✅ Summary generated: ${ocrResult.filename}`);
          }
        } catch (error) {
          console.error(`   ⚠️ Summary failed: ${ocrResult.filename} - ${error.message}`);
        }
      }

      sla.markComplete();
      const slaSummary = sla.getSummary();

      // Update chart with AI results
      await ChartRepository.updateWithAIResults(chartNumber, aiResult.data, slaSummary);

      // Mark job as completed
      await QueueService.completeJob(job.job_id);

      console.log('\n' + '═'.repeat(60));
      console.log(`✅ JOB COMPLETED: ${job.job_id}`);
      console.log(`   Chart: ${chartNumber}`);
      console.log(`   Duration: ${slaSummary.durations.total}`);
      console.log('═'.repeat(60) + '\n');

    } catch (error) {
      console.error(`\n❌ JOB FAILED: ${job.job_id}`);
      console.error(`   Error: ${error.message}`);

      // Mark job as failed
      await QueueService.failJob(job.job_id, error.message);

      // Update chart status to failed if max attempts reached
      const jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
      if (job.attempts >= job.max_attempts) {
        await ChartRepository.updateStatus(jobData.chartNumber, 'failed');
      }
    }
  }

  /**
   * Perform OCR on a document (downloads from S3, runs OCR)
   */
  async performOCR(doc) {
    const startTime = Date.now();
    let tempPath = null;

    try {
      // Download file from S3 to temp location
      console.log(`      Downloading from S3: ${doc.s3Url}`);
      const response = await axios.get(doc.s3Url, {
        responseType: 'arraybuffer',
        timeout: 60000 // 60 second timeout
      });

      // Create temp file
      const tempDir = os.tmpdir();
      const safeFilename = doc.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tempPath = path.join(tempDir, `ocr_${Date.now()}_${safeFilename}`);
      fs.writeFileSync(tempPath, response.data);

      console.log(`      Temp file created: ${tempPath}`);

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
      console.error(`      OCR error: ${error.message}`);
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

    this.shutdownRequested = true;
    console.log('\n⚠️ Shutdown requested, finishing current job...');
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
