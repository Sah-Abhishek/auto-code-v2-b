import { ocrService } from '../services/ocrService.js';
import { aiService } from '../services/aiService.js';
import { s3Service } from '../services/s3Service.js';
import { cleanupFiles } from '../middleware/upload.js';
import { createSLATracker } from '../utils/slaTracker.js';
import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';

class DocumentController {

  /**
   * Process uploaded documents through full pipeline
   * POST /api/documents/process
   */
  async processDocuments(req, res) {
    const sla = createSLATracker();
    sla.markUploadReceived();

    try {
      const files = req.files || [];
      const { documentType, mrn, chartNumber, facility, specialty, dateOfService, provider } = req.body;

      // Validation
      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      if (!chartNumber) {
        cleanupFiles(files);
        return res.status(400).json({ success: false, error: 'Chart number is required' });
      }

      const chartInfo = { mrn, chartNumber, facility, specialty, dateOfService, provider };

      // Log request
      console.log('\n' + '═'.repeat(70));
      console.log('📥 DOCUMENT PROCESSING REQUEST');
      console.log('═'.repeat(70));
      console.log(`📋 Document Type: ${documentType || 'Not specified'}`);
      console.log(`🏥 MRN: ${mrn || 'N/A'} | Chart: ${chartNumber}`);
      console.log(`🏢 Facility: ${facility || 'N/A'} | Specialty: ${specialty || 'N/A'}`);
      console.log(`📎 Files: ${files.length}`);
      files.forEach((f, i) => console.log(`   ${i + 1}. ${f.originalname} (${(f.size / 1024).toFixed(1)}KB)`));
      console.log('─'.repeat(70));

      // Create/Update chart in database
      console.log('\n💾 SAVING TO DATABASE');
      const chart = await ChartRepository.create({
        chartNumber,
        mrn: mrn || '',
        facility: facility || '',
        specialty: specialty || '',
        dateOfService: dateOfService || null,
        provider: provider || '',
        documentCount: files.length
      });
      console.log(`   ✅ Chart saved: ID ${chart.id}`);

      // ═══════════════════════════════════════════════════════════════
      // PHASE 1: Upload to S3 + OCR Processing
      // ═══════════════════════════════════════════════════════════════
      console.log('\n☁️  PHASE 1: S3 UPLOAD & OCR PROCESSING');
      sla.markOCRStarted();

      const documentRecords = [];
      const ocrResults = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log(`   [${i + 1}/${files.length}] Processing ${file.originalname}...`);

        // Upload to S3
        const s3Result = await s3Service.uploadFile(file, chartNumber, documentType);

        if (!s3Result.success) {
          console.error(`   ❌ S3 upload failed for ${file.originalname}`);
          continue;
        }

        // Create document record
        const docRecord = await DocumentRepository.create(chart.id, {
          documentType: documentType || 'unknown',
          filename: file.filename,
          originalName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          s3Key: s3Result.key,
          s3Url: s3Result.url,
          s3Bucket: s3Result.bucket
        });

        documentRecords.push(docRecord);

        // OCR Processing
        const ocrResult = await ocrService.extractText(file, documentType);

        if (ocrResult.success) {
          // Update document with OCR text
          await DocumentRepository.updateOCRResults(
            docRecord.id,
            typeof ocrResult.extractedText === 'string'
              ? ocrResult.extractedText
              : JSON.stringify(ocrResult.extractedText),
            ocrResult.processingTime
          );

          ocrResults.push({
            ...ocrResult,
            documentId: docRecord.id,
            s3Url: s3Result.url
          });
        } else {
          ocrResults.push({
            ...ocrResult,
            documentId: docRecord.id,
            s3Url: s3Result.url
          });
        }
      }

      sla.markOCRCompleted();

      const successfulOCR = ocrResults.filter(r => r.success);
      console.log(`   ✅ S3 & OCR Complete: ${successfulOCR.length}/${ocrResults.length} files`);

      if (successfulOCR.length === 0) {
        await ChartRepository.updateStatus(chartNumber, 'failed');
        cleanupFiles(files);
        return res.status(500).json({
          success: false,
          error: 'All OCR processing failed',
          chartNumber,
          sla: sla.markComplete().getSummary()
        });
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: AI Coding Analysis
      // ═══════════════════════════════════════════════════════════════
      console.log('\n🤖 PHASE 2: AI CODING ANALYSIS');
      sla.markAIStarted();

      const formattedDocs = ocrService.formatForAI(ocrResults);
      const aiResult = await aiService.processForCoding(formattedDocs, chartInfo);

      sla.markAICompleted();

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: Generate Document Summaries
      // ═══════════════════════════════════════════════════════════════
      console.log('\n📝 PHASE 3: DOCUMENT SUMMARIES');

      // Generate summary for each document
      for (const ocrResult of successfulOCR) {
        try {
          const docSummary = await aiService.generateDocumentSummary(ocrResult, chartInfo);
          if (docSummary.success) {
            await DocumentRepository.updateAISummary(ocrResult.documentId, docSummary.data);
            console.log(`   ✅ Summary generated for: ${ocrResult.filename}`);
          }
        } catch (error) {
          console.error(`   ⚠️ Failed to generate summary for ${ocrResult.filename}: ${error.message}`);
        }
      }

      sla.markComplete();

      // Get SLA summary
      const slaSummary = sla.getSummary();

      // Update chart with AI results
      if (aiResult.success) {
        await ChartRepository.updateWithAIResults(chartNumber, aiResult.data, slaSummary);

        // Update code count in metadata
        if (aiResult.data?.diagnosis_codes) {
          const codes = aiResult.data.diagnosis_codes;
          const totalCodes =
            (codes.principal_diagnosis?.icd_10_code ? 1 : 0) +
            (codes.secondary_diagnoses?.length || 0) +
            (codes.comorbidities?.length || 0);

          if (aiResult.data.metadata) {
            aiResult.data.metadata.total_codes_suggested = totalCodes;
          }
        }
      } else {
        await ChartRepository.updateStatus(chartNumber, 'failed');
      }

      // Cleanup local files (they're in S3 now)
      cleanupFiles(files);

      // Log completion
      console.log('\n' + '═'.repeat(70));
      console.log('📊 PROCESSING COMPLETE');
      console.log('═'.repeat(70));
      console.log(`⏱️  Total: ${slaSummary.durations.total} | OCR: ${slaSummary.durations.ocr} | AI: ${slaSummary.durations.ai}`);
      console.log(`📈 SLA Status: ${slaSummary.slaStatus.status.toUpperCase()}`);
      console.log(`💾 Stored in database: Chart ${chartNumber}`);
      console.log(`☁️  Documents uploaded to S3: ${documentRecords.length}`);
      console.log('═'.repeat(70) + '\n');

      // Response
      res.json({
        success: true,
        message: `Processed ${files.length} document(s) successfully`,
        chartNumber,
        chartId: chart.id,
        chartInfo,
        documentType,

        documents: documentRecords.map((doc, idx) => ({
          id: doc.id,
          filename: doc.original_name,
          documentType: doc.document_type,
          s3Url: doc.s3_url,
          ocrStatus: ocrResults[idx]?.success ? 'completed' : 'failed',
          processingTime: ocrResults[idx]?.processingTime
        })),

        ocr: {
          filesProcessed: ocrResults.length,
          successful: successfulOCR.length,
          failed: ocrResults.length - successfulOCR.length
        },

        coding: aiResult.success ? aiResult.data : { error: aiResult.error },

        sla: slaSummary
      });

    } catch (error) {
      console.error('❌ Processing error:', error);

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
   * Health check
   */
  async healthCheck(req, res) {
    res.json({
      success: true,
      service: 'MedCode AI - Document Processing & Coding Service',
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  }
}

export const documentController = new DocumentController();
