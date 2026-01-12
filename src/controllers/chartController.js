import { ChartRepository } from '../db/chartRepository.js';
import { calculateSLAHours } from '../utils/slaTracker.js';

class ChartController {

  /**
   * Get all charts (work queue)
   * GET /api/charts
   */
  async getCharts(req, res) {
    try {
      const {
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page = 1,
        limit = 10,
        sortBy,
        sortOrder
      } = req.query;

      const result = await ChartRepository.getAll({
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      });

      // Add SLA info to each chart
      const chartsWithSLA = result.charts.map(chart => {
        const slaInfo = calculateSLAHours(chart.processing_completed_at);

        return {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,
          sla: slaInfo ? {
            hours: slaInfo.hours,
            isWarning: slaInfo.isWarning,
            isCritical: slaInfo.isCritical
          } : null,
          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        };
      });

      res.json({
        success: true,
        charts: chartsWithSLA,
        pagination: result.pagination
      });

    } catch (error) {
      console.error('❌ Error fetching charts:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get single chart with full details
   * GET /api/charts/:chartNumber
   */
  async getChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.getWithDocuments(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      const slaInfo = calculateSLAHours(chart.processing_completed_at);

      res.json({
        success: true,
        chart: {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,

          // AI Results (current state - may include modifications)
          aiSummary: chart.ai_summary,
          diagnosisCodes: chart.diagnosis_codes,
          procedures: chart.procedures,
          medications: chart.medications,
          vitalsSummary: chart.vitals_summary,
          labResultsSummary: chart.lab_results_summary,
          codingNotes: chart.coding_notes,

          // Original AI codes (unmodified - for comparison)
          originalAICodes: chart.original_ai_codes,

          // User modifications tracking
          userModifications: chart.user_modifications,

          // Final submitted codes
          finalCodes: chart.final_codes,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,

          // SLA
          slaData: chart.sla_data,
          sla: slaInfo,
          processingStartedAt: chart.processing_started_at,
          processingCompletedAt: chart.processing_completed_at,

          // Documents
          documents: chart.documents?.map(doc => ({
            id: doc.id,
            documentType: doc.document_type,
            filename: doc.original_name,
            fileSize: doc.file_size,
            mimeType: doc.mime_type,
            s3Url: doc.s3_url,
            s3Key: doc.s3_key,
            ocrStatus: doc.ocr_status,
            ocrText: doc.ocr_text,
            ocrProcessingTime: doc.ocr_processing_time,
            aiDocumentSummary: doc.ai_document_summary,
            createdAt: doc.created_at
          })),

          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        }
      });

    } catch (error) {
      console.error('❌ Error fetching chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Save user modifications to codes
   * POST /api/charts/:chartNumber/modifications
   * 
   * Body: {
   *   modifications: {
   *     ed_em_level: [{ action: 'modified', original: {...}, modified: {...}, reason: '...', comment: '...' }],
   *     procedures: [...],
   *     primary_diagnosis: [...],
   *     secondary_diagnoses: [...],
   *     modifiers: [...]
   *   }
   * }
   */
  async saveModifications(req, res) {
    try {
      const { chartNumber } = req.params;
      const { modifications } = req.body;

      if (!modifications) {
        return res.status(400).json({
          success: false,
          error: 'Modifications data is required'
        });
      }

      // Add timestamp to modifications
      const timestampedModifications = {
        ...modifications,
        last_modified_at: new Date().toISOString()
      };

      const chart = await ChartRepository.saveUserModifications(chartNumber, timestampedModifications);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Modifications saved',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          userModifications: chart.user_modifications
        }
      });

    } catch (error) {
      console.error('❌ Error saving modifications:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Submit final codes to NextCode
   * POST /api/charts/:chartNumber/submit
   * 
   * Body: {
   *   finalCodes: {
   *     ed_em_level: [...],
   *     procedures: [...],
   *     primary_diagnosis: [...],
   *     secondary_diagnoses: [...],
   *     modifiers: [...]
   *   },
   *   modifications: { ... },  // Full modification history
   *   submittedBy: 'user@email.com'  // Optional
   * }
   */
  async submitCodes(req, res) {
    try {
      const { chartNumber } = req.params;
      const { finalCodes, modifications, submittedBy } = req.body;

      if (!finalCodes) {
        return res.status(400).json({
          success: false,
          error: 'Final codes are required'
        });
      }

      // First save the modifications if provided
      if (modifications) {
        await ChartRepository.saveUserModifications(chartNumber, {
          ...modifications,
          submitted_at: new Date().toISOString()
        });
      }

      // Then submit the final codes
      const chart = await ChartRepository.submitFinalCodes(chartNumber, finalCodes, submittedBy);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      console.log(`✅ Chart ${chartNumber} submitted to NextCode`);
      console.log(`   Final codes:`, JSON.stringify(finalCodes, null, 2).substring(0, 500));

      res.json({
        success: true,
        message: 'Codes submitted successfully to NextCode',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,
          finalCodes: chart.final_codes
        }
      });

    } catch (error) {
      console.error('❌ Error submitting codes:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update chart review status
   * PATCH /api/charts/:chartNumber/status
   */
  async updateStatus(req, res) {
    try {
      const { chartNumber } = req.params;
      const { reviewStatus } = req.body;

      const validStatuses = ['pending', 'in_review', 'submitted', 'rejected'];
      if (!validStatuses.includes(reviewStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }

      const chart = await ChartRepository.updateReviewStatus(chartNumber, reviewStatus);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Status updated',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status
        }
      });

    } catch (error) {
      console.error('❌ Error updating status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get SLA statistics
   * GET /api/charts/stats/sla
   */
  async getSLAStats(req, res) {
    try {
      const stats = await ChartRepository.getSLAStats();

      res.json({
        success: true,
        stats: {
          total: parseInt(stats.total),
          pendingReview: parseInt(stats.pending_review),
          processing: parseInt(stats.processing),
          inReview: parseInt(stats.in_review),
          submitted: parseInt(stats.submitted),
          slaWarning: parseInt(stats.sla_warning),
          slaCritical: parseInt(stats.sla_critical)
        }
      });

    } catch (error) {
      console.error('❌ Error fetching SLA stats:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get modification analytics
   * GET /api/charts/analytics/modifications
   */
  async getModificationAnalytics(req, res) {
    try {
      const { startDate, endDate, facility } = req.query;

      const data = await ChartRepository.getModificationAnalytics({
        startDate,
        endDate,
        facility
      });

      // Calculate summary statistics
      const totalSubmitted = data.length;
      const chartsWithMods = data.filter(d =>
        d.user_modifications && Object.keys(d.user_modifications).length > 0
      ).length;

      // Aggregate modification reasons
      const reasonCounts = {};
      const categoryModCounts = {
        ed_em_level: 0,
        procedures: 0,
        primary_diagnosis: 0,
        secondary_diagnoses: 0,
        modifiers: 0
      };

      data.forEach(chart => {
        if (chart.user_modifications) {
          Object.entries(chart.user_modifications).forEach(([category, mods]) => {
            if (Array.isArray(mods)) {
              categoryModCounts[category] = (categoryModCounts[category] || 0) + mods.length;
              mods.forEach(mod => {
                if (mod.reason) {
                  reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
                }
              });
            }
          });
        }
      });

      res.json({
        success: true,
        analytics: {
          summary: {
            totalSubmitted,
            chartsWithModifications: chartsWithMods,
            modificationRate: totalSubmitted > 0 ? (chartsWithMods / totalSubmitted * 100).toFixed(1) : 0
          },
          byCategory: categoryModCounts,
          byReason: reasonCounts,
          recentSubmissions: data.slice(0, 20).map(d => ({
            chartNumber: d.chart_number,
            facility: d.facility,
            submittedAt: d.submitted_at,
            hasModifications: d.user_modifications && Object.keys(d.user_modifications).length > 0
          }))
        }
      });

    } catch (error) {
      console.error('❌ Error fetching analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get comprehensive analytics for dashboard
   * GET /api/charts/analytics/dashboard
   */
  async getDashboardAnalytics(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const { period = '30' } = req.query; // days
      const periodDays = parseInt(period);

      // Get overall stats
      const overallStats = await query(`
        SELECT 
          COUNT(*) as total_charts,
          COUNT(*) FILTER (WHERE review_status = 'submitted') as submitted_charts,
          COUNT(*) FILTER (WHERE review_status = 'pending') as pending_charts,
          COUNT(*) FILTER (WHERE review_status = 'in_review') as in_review_charts,
          COUNT(*) FILTER (WHERE ai_status = 'processing') as processing_charts,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as charts_in_period
        FROM charts
      `);

      // Get acceptance rate (codes accepted without modification)
      const acceptanceData = await query(`
        SELECT 
          COUNT(*) as total_submitted,
          COUNT(*) FILTER (
            WHERE user_modifications IS NULL 
            OR user_modifications = '{}'
            OR jsonb_typeof(user_modifications) = 'null'
          ) as accepted_without_changes
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get volume by facility
      const volumeByFacility = await query(`
        SELECT 
          facility,
          COUNT(*) as chart_count
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        AND facility IS NOT NULL AND facility != ''
        GROUP BY facility
        ORDER BY chart_count DESC
        LIMIT 10
      `);

      // Get weekly trends for acceptance rate
      const weeklyTrends = await query(`
        SELECT 
          DATE_TRUNC('week', submitted_at) as week,
          COUNT(*) as total,
          COUNT(*) FILTER (
            WHERE user_modifications IS NULL 
            OR user_modifications = '{}'
          ) as accepted
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE_TRUNC('week', submitted_at)
        ORDER BY week
      `);

      // Get modification reasons breakdown
      const modificationReasons = await query(`
        SELECT user_modifications
        FROM charts
        WHERE review_status = 'submitted'
        AND user_modifications IS NOT NULL
        AND user_modifications != '{}'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Process modification reasons
      const reasonCounts = {};
      let totalModifications = 0;

      modificationReasons.rows.forEach(row => {
        if (row.user_modifications) {
          Object.values(row.user_modifications).forEach(mods => {
            if (Array.isArray(mods)) {
              mods.forEach(mod => {
                totalModifications++;
                if (mod.reason) {
                  reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
                }
              });
            }
          });
        }
      });

      // Get processing times
      const processingTimes = await query(`
        SELECT 
          AVG(EXTRACT(EPOCH FROM (processing_completed_at - processing_started_at))/60) as avg_processing_min,
          AVG(EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/60) as avg_review_min
        FROM charts
        WHERE review_status = 'submitted'
        AND processing_completed_at IS NOT NULL
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get SLA compliance
      const slaCompliance = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (
            WHERE EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/3600 <= 24
          ) as within_sla
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get charts per day average
      const chartsPerDay = await query(`
        SELECT 
          COUNT(*)::float / NULLIF(${periodDays}, 0) as avg_per_day
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get total codes for accuracy calculation
      const codeAccuracy = await query(`
        SELECT 
          COUNT(*) as total_codes,
          COUNT(*) FILTER (
            WHERE user_modifications IS NULL 
            OR user_modifications = '{}'
          ) as unchanged_codes
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
      `);

      // Get specialty accuracy trends (by week)
      const specialtyTrends = await query(`
        SELECT 
          DATE_TRUNC('week', submitted_at) as week,
          specialty,
          COUNT(*) as total,
          COUNT(*) FILTER (
            WHERE user_modifications IS NULL 
            OR user_modifications = '{}'
          ) as accurate
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
        AND specialty IS NOT NULL
        GROUP BY DATE_TRUNC('week', submitted_at), specialty
        ORDER BY week
      `);

      // Calculate metrics
      const totalSubmitted = parseInt(acceptanceData.rows[0]?.total_submitted || 0);
      const acceptedWithoutChanges = parseInt(acceptanceData.rows[0]?.accepted_without_changes || 0);
      const acceptanceRate = totalSubmitted > 0 ? (acceptedWithoutChanges / totalSubmitted * 100) : 0;

      const slaTotal = parseInt(slaCompliance.rows[0]?.total || 0);
      const slaWithin = parseInt(slaCompliance.rows[0]?.within_sla || 0);
      const slaComplianceRate = slaTotal > 0 ? (slaWithin / slaTotal * 100) : 0;

      // Calculate overall accuracy from actual data
      const totalCodes = parseInt(codeAccuracy.rows[0]?.total_codes || 0);
      const unchangedCodes = parseInt(codeAccuracy.rows[0]?.unchanged_codes || 0);
      const overallAccuracy = totalCodes > 0 ? (unchangedCodes / totalCodes * 100) : 0;

      // Format weekly trends
      const formattedTrends = weeklyTrends.rows.map((row, idx) => ({
        week: `Week ${idx + 1}`,
        date: row.week,
        total: parseInt(row.total),
        accepted: parseInt(row.accepted),
        acceptanceRate: row.total > 0 ? parseFloat((parseInt(row.accepted) / parseInt(row.total) * 100).toFixed(1)) : 0
      }));

      // Format specialty accuracy trends
      const specialtyAccuracyByWeek = {};
      specialtyTrends.rows.forEach(row => {
        const weekKey = row.week?.toISOString() || 'unknown';
        if (!specialtyAccuracyByWeek[weekKey]) {
          specialtyAccuracyByWeek[weekKey] = { week: weekKey, specialties: {} };
        }
        const accuracy = row.total > 0 ? (parseInt(row.accurate) / parseInt(row.total) * 100) : 0;
        specialtyAccuracyByWeek[weekKey].specialties[row.specialty] = accuracy;
      });

      const formattedSpecialtyTrends = Object.values(specialtyAccuracyByWeek).map((item, idx) => ({
        week: `Week ${idx + 1}`,
        ...item.specialties,
        accuracy: Object.values(item.specialties).length > 0
          ? Object.values(item.specialties).reduce((a, b) => a + b, 0) / Object.values(item.specialties).length
          : 0
      }));

      // Format correction reasons (top 5)
      const sortedReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({
          reason,
          count,
          percentage: totalModifications > 0 ? parseFloat((count / totalModifications * 100).toFixed(1)) : 0
        }));

      // Build dynamic alerts based on real data
      const alerts = [];
      const pendingCharts = parseInt(overallStats.rows[0]?.pending_charts || 0);

      if (pendingCharts > 0) {
        alerts.push({
          type: pendingCharts > 50 ? 'warning' : 'info',
          title: 'Queue Status',
          message: `${pendingCharts} charts pending review`
        });
      }

      if (slaComplianceRate < 90 && slaTotal > 0) {
        alerts.push({
          type: 'warning',
          title: 'SLA Alert',
          message: `SLA compliance at ${slaComplianceRate.toFixed(1)}%`
        });
      }

      if (alerts.length === 0) {
        alerts.push({
          type: 'success',
          title: 'All Systems Normal',
          message: 'No issues detected'
        });
      }

      res.json({
        success: true,
        analytics: {
          summary: {
            aiAcceptanceRate: parseFloat(acceptanceRate.toFixed(1)),
            chartsProcessed: parseInt(overallStats.rows[0]?.charts_in_period || 0),
            overallAccuracy: parseFloat(overallAccuracy.toFixed(1)),
            correctionRate: totalSubmitted > 0 ? parseFloat(((totalSubmitted - acceptedWithoutChanges) / totalSubmitted * 100).toFixed(1)) : 0,
            totalModifications,
            totalSubmitted
          },
          trends: {
            acceptanceRate: formattedTrends,
            weeklyVolume: formattedTrends.map(t => ({ week: t.week, count: t.total }))
          },
          specialtyAccuracy: formattedSpecialtyTrends,
          volumeByFacility: volumeByFacility.rows.map(r => ({
            facility: r.facility,
            count: parseInt(r.chart_count)
          })),
          correctionReasons: sortedReasons,
          performance: {
            avgProcessingTime: parseFloat(processingTimes.rows[0]?.avg_processing_min || 0).toFixed(1),
            avgReviewTime: parseFloat(processingTimes.rows[0]?.avg_review_min || 0).toFixed(1),
            totalCycleTime: (
              parseFloat(processingTimes.rows[0]?.avg_processing_min || 0) +
              parseFloat(processingTimes.rows[0]?.avg_review_min || 0)
            ).toFixed(1),
            queueBacklog: pendingCharts,
            slaCompliance: parseFloat(slaComplianceRate.toFixed(1)),
            chartsPerDay: parseFloat(chartsPerDay.rows[0]?.avg_per_day || 0).toFixed(1)
          },
          alerts
        }
      });

    } catch (error) {
      console.error('❌ Error fetching dashboard analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get distinct facilities
   * GET /api/charts/filters/facilities
   */
  async getFacilities(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT facility FROM charts WHERE facility IS NOT NULL AND facility != '' ORDER BY facility`
      );

      res.json({
        success: true,
        facilities: result.rows.map(r => r.facility)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get distinct specialties
   * GET /api/charts/filters/specialties
   */
  async getSpecialties(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT specialty FROM charts WHERE specialty IS NOT NULL AND specialty != '' ORDER BY specialty`
      );

      res.json({
        success: true,
        specialties: result.rows.map(r => r.specialty)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete chart
   * DELETE /api/charts/:chartNumber
   */
  async deleteChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.delete(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Chart deleted',
        chartNumber
      });

    } catch (error) {
      console.error('❌ Error deleting chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const chartController = new ChartController();
