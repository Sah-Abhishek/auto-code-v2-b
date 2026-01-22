import { s3Service } from '../services/s3Service.js';
import { cleanupFiles } from '../middleware/upload.js';
import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { QueueService } from '../db/queueService.js';
import { v4 as uuidv4 } from 'uuid';

class DocumentController {

  /**
   * Process uploaded documents - ASYNC VERSION with Transaction Tracking
   * Uploads to S3, creates DB records, then queues for background processing
   * POST /api/documents/process
   * 
   * Transaction tracking:
   * - Each PDF = 1 transaction
   * - Each image group = 1 transaction (multiple images share same transaction_id)
   * 
   * Body can include:
   * - transactions: JSON string describing file groupings
   *   [{ type: 'pdf', fileIndex: 0 }, { type: 'image_group', label: 'Doc 1', fileIndices: [1,2,3] }]
   */
  async processDocuments(req, res) {
    try {
      const files = req.files || [];
      const { documentType, mrn, chartNumber, facility, specialty, dateOfService, provider, transactions } = req.body;

      // Validation
      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      if (!chartNumber) {
        cleanupFiles(files);
        return res.status(400).json({ success: false, error: 'Chart number is required' });
      }

      const chartInfo = { mrn, chartNumber, facility, specialty, dateOfService, provider };

      // Parse transaction metadata if provided
      let transactionMeta = [];
      if (transactions) {
        try {
          transactionMeta = JSON.parse(transactions);
        } catch (e) {
          // Use auto-detection if parsing fails
        }
      }

      // Log file received
      console.log(`\n[FILE RECEIVED] Chart: ${chartNumber} | Files: ${files.length}`);
      files.forEach((f, i) => console.log(`  - ${f.originalname} (${(f.size / 1024).toFixed(1)}KB)`));

      const chart = await ChartRepository.createQueued({
        chartNumber,
        mrn: mrn || '',
        facility: facility || '',
        specialty: specialty || '',
        dateOfService: dateOfService || null,
        provider: provider || '',
        documentCount: files.length
      });


      // Create a map of fileIndex -> transaction info
      const fileTransactionMap = new Map();

      if (transactionMeta.length > 0) {
        // Use provided transaction metadata
        transactionMeta.forEach(txn => {
          const transactionId = `txn_${uuidv4().substring(0, 8)}`;

          if (txn.type === 'pdf') {
            fileTransactionMap.set(txn.fileIndex, {
              transactionId,
              transactionLabel: txn.label || 'PDF Document',
              isGroupMember: false
            });
          } else if (txn.type === 'image_group') {
            txn.fileIndices.forEach(idx => {
              fileTransactionMap.set(idx, {
                transactionId,
                transactionLabel: txn.label || 'Image Group',
                isGroupMember: true
              });
            });
          }
        });
      } else {
        // Auto-detect: each file is its own transaction
        // PDFs get individual transactions, images get individual transactions
        files.forEach((file, idx) => {
          const transactionId = `txn_${uuidv4().substring(0, 8)}`;
          const isPdf = file.mimetype === 'application/pdf';
          fileTransactionMap.set(idx, {
            transactionId,
            transactionLabel: isPdf ? 'PDF Document' : 'Image',
            isGroupMember: !isPdf
          });
        });
      }

      const uniqueTransactions = new Set([...fileTransactionMap.values()].map(t => t.transactionId));

      const documentRecords = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Upload to S3
        const s3Result = await s3Service.uploadFile(file, chartNumber, documentType);

        if (!s3Result.success) {
          continue;
        }

        // Get transaction info for this file
        const txnInfo = fileTransactionMap.get(i) || {
          transactionId: `txn_${uuidv4().substring(0, 8)}`,
          transactionLabel: 'Unknown',
          isGroupMember: false
        };

        // Create document record in database with transaction info
        const docRecord = await DocumentRepository.create(chart.id, {
          documentType: documentType || 'unknown',
          filename: file.filename,
          originalName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          s3Key: s3Result.key,
          s3Url: s3Result.url,
          s3Bucket: s3Result.bucket,
          transactionId: txnInfo.transactionId,
          transactionLabel: txnInfo.transactionLabel,
          isGroupMember: txnInfo.isGroupMember
        });

        documentRecords.push({
          documentId: docRecord.id,
          documentType: docRecord.document_type,
          originalName: docRecord.original_name,
          mimeType: docRecord.mime_type,
          fileSize: docRecord.file_size,
          s3Key: docRecord.s3_key,
          s3Url: docRecord.s3_url,
          transactionId: docRecord.transaction_id
        });
      }

      // Cleanup local temp files (they're in S3 now)
      cleanupFiles(files);

      if (documentRecords.length === 0) {
        // All uploads failed
        await ChartRepository.updateStatus(chartNumber, 'failed');
        return res.status(500).json({
          success: false,
          error: 'All file uploads failed'
        });
      }

      const jobData = {
        chartId: chart.id,
        chartNumber,
        chartInfo,
        documentType,
        documents: documentRecords
      };

      const job = await QueueService.addJob(chart.id, chartNumber, jobData);

      // Response - returns immediately, processing happens in background
      res.json({
        success: true,
        message: `${files.length} document(s) uploaded and queued for processing`,
        status: 'queued',
        chartNumber,
        chartId: chart.id,
        jobId: job.job_id,
        chartInfo,
        documentType,
        transactionCount: uniqueTransactions.size,
        documents: documentRecords.map(doc => ({
          id: doc.documentId,
          filename: doc.originalName,
          documentType: doc.documentType,
          s3Url: doc.s3Url,
          transactionId: doc.transactionId,
          status: 'uploaded'
        })),
        estimatedProcessingTime: '30-60 seconds'
      });

    } catch (error) {
      if (req.files) {
        cleanupFiles(req.files);
      }

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get processing status for a chart
   * GET /api/documents/status/:chartNumber
   */
  async getProcessingStatus(req, res) {
    try {
      const { chartNumber } = req.params;

      // Get chart status
      const chart = await ChartRepository.getByChartNumber(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      // Get queue job status
      const jobs = await QueueService.getJobsByChart(chartNumber);
      const latestJob = jobs[0];

      res.json({
        success: true,
        chartNumber,
        aiStatus: chart.ai_status,
        reviewStatus: chart.review_status,
        processingStartedAt: chart.processing_started_at,
        processingCompletedAt: chart.processing_completed_at,
        job: latestJob ? {
          jobId: latestJob.job_id,
          status: latestJob.status,
          attempts: latestJob.attempts,
          maxAttempts: latestJob.max_attempts,
          createdAt: latestJob.created_at,
          startedAt: latestJob.started_at,
          completedAt: latestJob.completed_at,
          error: latestJob.error_message
        } : null
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get queue statistics
   * GET /api/documents/queue/stats
   */
  async getQueueStats(req, res) {
    try {
      const stats = await QueueService.getStats();

      res.json({
        success: true,
        stats: {
          pending: parseInt(stats.pending || 0),
          processing: parseInt(stats.processing || 0),
          completed: parseInt(stats.completed || 0),
          failed: parseInt(stats.permanently_failed || 0),
          retrying: parseInt(stats.retrying || 0),
          total: parseInt(stats.total || 0)
        }
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get transaction statistics
   * GET /api/documents/transactions/stats
   */
  async getTransactionStats(req, res) {
    try {
      const stats = await ChartRepository.getTransactionStats();

      res.json({
        success: true,
        stats: {
          totalTransactions: parseInt(stats.total_transactions || 0),
          pdfTransactions: parseInt(stats.pdf_transactions || 0),
          imageGroupTransactions: parseInt(stats.image_group_transactions || 0),
          totalFiles: parseInt(stats.total_files || 0),
          totalPdfs: parseInt(stats.total_pdfs || 0),
          totalImages: parseInt(stats.total_images || 0)
        }
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get combined dashboard statistics
   * GET /api/documents/dashboard/stats
   */
  async getDashboardStats(req, res) {
    try {
      const stats = await ChartRepository.getDashboardStats();

      res.json({
        success: true,
        stats: {
          // Chart stats
          total: parseInt(stats.charts.total || 0),
          pendingReview: parseInt(stats.charts.pending_review || 0),
          queued: parseInt(stats.charts.queued || 0),
          processing: parseInt(stats.charts.processing || 0),
          inReview: parseInt(stats.charts.in_review || 0),
          submitted: parseInt(stats.charts.submitted || 0),
          // Transaction stats
          totalTransactions: parseInt(stats.transactions.total_transactions || 0),
          pdfTransactions: parseInt(stats.transactions.pdf_transactions || 0),
          imageGroupTransactions: parseInt(stats.transactions.image_group_transactions || 0),
          totalFiles: parseInt(stats.transactions.total_files || 0),
          // Done transactions (from submitted charts)
          doneTransactions: parseInt(stats.transactions.done_transactions || 0),
          donePdfTransactions: parseInt(stats.transactions.done_pdf_transactions || 0),
          doneImageGroupTransactions: parseInt(stats.transactions.done_image_group_transactions || 0)
        }
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Health check
   */
  async healthCheck(req, res) {
    try {
      // Quick queue stats for health check
      const queueStats = await QueueService.getStats();

      res.json({
        success: true,
        service: 'MedCode AI - Document Processing & Coding Service',
        status: 'healthy',
        mode: 'async-queue',
        queue: {
          pending: parseInt(queueStats.pending || 0),
          processing: parseInt(queueStats.processing || 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.json({
        success: true,
        service: 'MedCode AI - Document Processing & Coding Service',
        status: 'healthy',
        mode: 'async-queue',
        timestamp: new Date().toISOString()
      });
    }
  }
}

export const documentController = new DocumentController();
