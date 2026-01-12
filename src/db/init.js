import { pool } from './connection.js';

const createTablesSQL = `
-- Charts table - stores chart information and AI results
CREATE TABLE IF NOT EXISTS charts (
  id SERIAL PRIMARY KEY,
  chart_number VARCHAR(50) UNIQUE NOT NULL,
  mrn VARCHAR(50) NOT NULL,
  facility VARCHAR(255),
  specialty VARCHAR(100),
  date_of_service DATE,
  provider VARCHAR(255),
  
  -- Processing status
  ai_status VARCHAR(50) DEFAULT 'queued',
  review_status VARCHAR(50) DEFAULT 'pending',
  
  -- Document tracking
  document_count INTEGER DEFAULT 0,
  
  -- AI Results (stored as JSONB)
  ai_summary JSONB,
  diagnosis_codes JSONB,
  procedures JSONB,
  medications JSONB,
  vitals_summary JSONB,
  lab_results_summary JSONB,
  coding_notes JSONB,
  
  -- SLA tracking
  sla_data JSONB,
  processing_started_at TIMESTAMP,
  processing_completed_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Documents table - stores individual documents for each chart with S3 URLs
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  chart_id INTEGER REFERENCES charts(id) ON DELETE CASCADE,
  document_type VARCHAR(100),
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  file_size INTEGER,
  mime_type VARCHAR(100),
  
  -- S3 Storage
  s3_key VARCHAR(500),
  s3_url VARCHAR(1000),
  s3_bucket VARCHAR(255),
  
  -- OCR results
  ocr_text TEXT,
  ocr_status VARCHAR(50) DEFAULT 'pending',
  ocr_processing_time INTEGER,
  ocr_completed_at TIMESTAMP,
  
  -- AI Document Summary
  ai_document_summary JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_charts_chart_number ON charts(chart_number);
CREATE INDEX IF NOT EXISTS idx_charts_mrn ON charts(mrn);
CREATE INDEX IF NOT EXISTS idx_charts_ai_status ON charts(ai_status);
CREATE INDEX IF NOT EXISTS idx_charts_review_status ON charts(review_status);
CREATE INDEX IF NOT EXISTS idx_charts_facility ON charts(facility);
CREATE INDEX IF NOT EXISTS idx_charts_specialty ON charts(specialty);
CREATE INDEX IF NOT EXISTS idx_charts_created_at ON charts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_chart_id ON documents(chart_id);
CREATE INDEX IF NOT EXISTS idx_documents_document_type ON documents(document_type);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_charts_updated_at ON charts;
CREATE TRIGGER update_charts_updated_at
  BEFORE UPDATE ON charts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
`;

async function initializeDatabase() {
  console.log('🔧 Initializing database...');

  try {
    await pool.query(createTablesSQL);
    console.log('✅ Database tables created successfully');

    // Check tables
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log('📋 Tables:', result.rows.map(r => r.table_name).join(', '));

  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
initializeDatabase()
  .then(() => {
    console.log('✅ Database initialization complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Failed:', err);
    process.exit(1);
  });
