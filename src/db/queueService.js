import { pool, query } from './connection.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Database-backed job queue for async document processing
 * Uses PostgreSQL with FOR UPDATE SKIP LOCKED for safe concurrent access
 */
export const QueueService = {

  /**
   * Add a new job to the processing queue
   */
  async addJob(chartId, chartNumber, jobData) {
    const jobId = uuidv4();

    const result = await query(
      `INSERT INTO processing_queue (
        job_id, chart_id, chart_number, status, job_data
      ) VALUES ($1, $2, $3, 'pending', $4)
      RETURNING *`,
      [jobId, chartId, chartNumber, JSON.stringify(jobData)]
    );

    console.log(`📋 Job queued: ${jobId} for chart ${chartNumber}`);
    return result.rows[0];
  },

  /**
   * Claim the next available job for processing
   * Uses FOR UPDATE SKIP LOCKED to prevent race conditions
   */
  async claimNextJob(workerId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Find and lock the next pending job (or failed job with retries left)
      const result = await client.query(
        `SELECT * FROM processing_queue 
         WHERE (status = 'pending' OR (status = 'failed' AND attempts < max_attempts))
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null; // No jobs available
      }

      const job = result.rows[0];

      // Update job to processing status
      await client.query(
        `UPDATE processing_queue SET 
          status = 'processing',
          worker_id = $1,
          locked_at = CURRENT_TIMESTAMP,
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          attempts = attempts + 1
         WHERE id = $2`,
        [workerId, job.id]
      );

      await client.query('COMMIT');

      console.log(`🔒 Job claimed: ${job.job_id} by worker ${workerId}`);
      return { ...job, status: 'processing', worker_id: workerId };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Mark a job as completed
   */
  async completeJob(jobId) {
    const result = await query(
      `UPDATE processing_queue SET 
        status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        locked_at = NULL
       WHERE job_id = $1
       RETURNING *`,
      [jobId]
    );

    if (result.rows[0]) {
      console.log(`✅ Job completed: ${jobId}`);
    }
    return result.rows[0];
  },

  /**
   * Mark a job as failed
   */
  async failJob(jobId, errorMessage) {
    const result = await query(
      `UPDATE processing_queue SET 
        status = 'failed',
        error_message = $2,
        locked_at = NULL
       WHERE job_id = $1
       RETURNING *`,
      [jobId, errorMessage]
    );

    if (result.rows[0]) {
      const job = result.rows[0];
      if (job.attempts >= job.max_attempts) {
        console.log(`❌ Job permanently failed: ${jobId} (${job.attempts}/${job.max_attempts} attempts)`);
      } else {
        console.log(`⚠️ Job failed, will retry: ${jobId} (${job.attempts}/${job.max_attempts} attempts)`);
      }
    }
    return result.rows[0];
  },

  /**
   * Get job by ID
   */
  async getJob(jobId) {
    const result = await query(
      `SELECT * FROM processing_queue WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0];
  },

  /**
   * Get jobs by chart number
   */
  async getJobsByChart(chartNumber) {
    const result = await query(
      `SELECT * FROM processing_queue WHERE chart_number = $1 ORDER BY created_at DESC`,
      [chartNumber]
    );
    return result.rows;
  },

  /**
   * Get queue statistics
   */
  async getStats() {
    const result = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts) as permanently_failed,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts) as retrying,
        COUNT(*) as total
      FROM processing_queue
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    return result.rows[0];
  },

  /**
   * Clean up old completed jobs (run periodically)
   */
  async cleanupOldJobs(olderThanDays = 7) {
    const result = await query(
      `DELETE FROM processing_queue 
       WHERE status = 'completed' 
       AND completed_at < NOW() - INTERVAL '1 day' * $1
       RETURNING id`,
      [olderThanDays]
    );

    if (result.rows.length > 0) {
      console.log(`🧹 Cleaned up ${result.rows.length} old completed jobs`);
    }
    return result.rows.length;
  },

  /**
   * Release stuck jobs (jobs that have been processing for too long)
   */
  async releaseStuckJobs(stuckMinutes = 30) {
    const result = await query(
      `UPDATE processing_queue SET 
        status = 'pending',
        worker_id = NULL,
        locked_at = NULL,
        error_message = 'Released: worker timeout'
       WHERE status = 'processing'
       AND locked_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING *`,
      [stuckMinutes]
    );

    if (result.rows.length > 0) {
      console.log(`🔓 Released ${result.rows.length} stuck jobs`);
    }
    return result.rows;
  }
};

export default QueueService;
