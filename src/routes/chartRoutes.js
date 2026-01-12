import { Router } from 'express';
import { chartController } from '../controllers/chartController.js';
import { query } from '../db/connection.js';

const router = Router();

// SLA Statistics (must be before :chartNumber route)
router.get('/stats/sla', chartController.getSLAStats.bind(chartController));

// Analytics endpoints
router.get('/analytics/modifications', chartController.getModificationAnalytics.bind(chartController));
router.get('/analytics/dashboard', chartController.getDashboardAnalytics.bind(chartController));

// Filter options
router.get('/filters/facilities', chartController.getFacilities.bind(chartController));
router.get('/filters/specialties', chartController.getSpecialties.bind(chartController));

// Debug endpoint - get raw data from database
router.get('/debug/:chartNumber', async (req, res) => {
  try {
    const { chartNumber } = req.params;

    // Get chart
    const chartResult = await query(
      'SELECT * FROM charts WHERE chart_number = $1',
      [chartNumber]
    );

    if (chartResult.rows.length === 0) {
      return res.json({ success: false, error: 'Chart not found' });
    }

    const chart = chartResult.rows[0];

    // Get documents with all fields
    const docsResult = await query(
      `SELECT id, document_type, filename, original_name, file_size, mime_type, 
              s3_key, s3_url, s3_bucket, ocr_status, ocr_processing_time, 
              LENGTH(ocr_text) as ocr_text_length,
              SUBSTRING(ocr_text, 1, 200) as ocr_text_preview
       FROM documents WHERE chart_id = $1`,
      [chart.id]
    );

    res.json({
      success: true,
      chart: {
        id: chart.id,
        chart_number: chart.chart_number,
        mrn: chart.mrn,
        ai_status: chart.ai_status,
        review_status: chart.review_status,
        original_ai_codes: chart.original_ai_codes,
        user_modifications: chart.user_modifications,
        final_codes: chart.final_codes,
        submitted_at: chart.submitted_at
      },
      documents: docsResult.rows,
      message: 'Raw database data for debugging'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all charts (work queue)
router.get('/', chartController.getCharts.bind(chartController));

// Get single chart with full details
router.get('/:chartNumber', chartController.getChart.bind(chartController));

// Save user modifications (auto-save as user edits)
router.post('/:chartNumber/modifications', chartController.saveModifications.bind(chartController));

// Submit final codes to NextCode
router.post('/:chartNumber/submit', chartController.submitCodes.bind(chartController));

// Update chart review status
router.patch('/:chartNumber/status', chartController.updateStatus.bind(chartController));

// Delete chart
router.delete('/:chartNumber', chartController.deleteChart.bind(chartController));

export default router;
