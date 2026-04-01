import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

// Disable SSL certificate verification for cloud DBs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  const client = await pool.connect();

  try {
    console.log('🚀 Starting database initialization (mc_ prefixed tables)...\n');

    // ═══════════════════════════════════════════════════════════════
    // DROP ONLY mc_ PREFIXED TABLES (safe - won't touch other data)
    // ═══════════════════════════════════════════════════════════════
    console.log('🗑️  Dropping existing mc_ tables (if any)...');
    await client.query(`DROP TABLE IF EXISTS mc_processing_queue CASCADE`);
    await client.query(`DROP TABLE IF EXISTS mc_documents CASCADE`);
    await client.query(`DROP TABLE IF EXISTS mc_charts CASCADE`);
    await client.query(`DROP TABLE IF EXISTS mc_users CASCADE`);
    console.log('   ✅ Old mc_ tables dropped\n');

    // ═══════════════════════════════════════════════════════════════
    // MC_CHARTS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('📋 Creating mc_charts table...');
    await client.query(`
      CREATE TABLE mc_charts (
        id SERIAL PRIMARY KEY,
        chart_number VARCHAR(100) UNIQUE NOT NULL,
        mrn VARCHAR(100),
        facility VARCHAR(255),
        specialty VARCHAR(255),
        date_of_service DATE,
        provider VARCHAR(255),
        document_count INTEGER DEFAULT 0,

        -- AI Processing Status
        ai_status VARCHAR(50) DEFAULT 'queued',
        review_status VARCHAR(50) DEFAULT 'pending',

        -- AI Results (JSON fields)
        ai_summary JSONB,
        diagnosis_codes JSONB,
        procedures JSONB,
        medications JSONB,
        vitals_summary JSONB,
        lab_results_summary JSONB,
        coding_notes JSONB,
        sla_data JSONB,

        -- Original AI codes for comparison
        original_ai_codes JSONB,

        -- User modifications
        user_modifications JSONB,

        -- Final submitted codes
        final_codes JSONB,
        submitted_at TIMESTAMP,
        submitted_by VARCHAR(100),

        -- Error tracking
        last_error TEXT,
        last_error_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,

        -- Processing timestamps
        processing_started_at TIMESTAMP,
        processing_completed_at TIMESTAMP,

        -- Record timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ mc_charts table created\n');

    // ═══════════════════════════════════════════════════════════════
    // MC_DOCUMENTS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('📄 Creating mc_documents table...');
    await client.query(`
      CREATE TABLE mc_documents (
        id SERIAL PRIMARY KEY,
        chart_id INTEGER REFERENCES mc_charts(id) ON DELETE CASCADE,
        document_type VARCHAR(100),
        filename VARCHAR(255),
        original_name VARCHAR(255),
        file_size INTEGER,
        mime_type VARCHAR(100),

        -- S3 Storage
        s3_key VARCHAR(500),
        s3_url TEXT,
        s3_bucket VARCHAR(255),

        -- OCR Processing
        ocr_status VARCHAR(50) DEFAULT 'pending',
        ocr_text TEXT,
        ocr_processing_time INTEGER,
        ocr_completed_at TIMESTAMP,

        -- AI Document Summary
        ai_document_summary JSONB,

        -- Transaction tracking
        transaction_id VARCHAR(100),
        transaction_label VARCHAR(255),
        is_group_member BOOLEAN DEFAULT FALSE,

        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ mc_documents table created\n');

    // ═══════════════════════════════════════════════════════════════
    // MC_PROCESSING_QUEUE TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('⏳ Creating mc_processing_queue table...');
    await client.query(`
      CREATE TABLE mc_processing_queue (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) UNIQUE NOT NULL,
        chart_id INTEGER REFERENCES mc_charts(id) ON DELETE CASCADE,
        chart_number VARCHAR(100),

        -- Job status
        status VARCHAR(50) DEFAULT 'pending',
        job_data JSONB,

        -- Worker tracking
        worker_id VARCHAR(100),
        locked_at TIMESTAMP,

        -- Timing
        started_at TIMESTAMP,
        completed_at TIMESTAMP,

        -- Retry logic
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        error_message TEXT,
        retry_after TIMESTAMP,

        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ mc_processing_queue table created\n');

    // ═══════════════════════════════════════════════════════════════
    // MC_USERS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('👤 Creating mc_users table...');
    await client.query(`
      CREATE TABLE mc_users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'coder',
        email VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ mc_users table created\n');

    // ═══════════════════════════════════════════════════════════════
    // INDEXES
    // ═══════════════════════════════════════════════════════════════
    console.log('🔍 Creating indexes...');

    // mc_charts indexes
    await client.query(`CREATE INDEX idx_mc_charts_ai_status ON mc_charts(ai_status)`);
    await client.query(`CREATE INDEX idx_mc_charts_review_status ON mc_charts(review_status)`);
    await client.query(`CREATE INDEX idx_mc_charts_facility ON mc_charts(facility)`);
    await client.query(`CREATE INDEX idx_mc_charts_specialty ON mc_charts(specialty)`);
    await client.query(`CREATE INDEX idx_mc_charts_mrn ON mc_charts(mrn)`);
    await client.query(`CREATE INDEX idx_mc_charts_created_at ON mc_charts(created_at DESC)`);
    await client.query(`CREATE INDEX idx_mc_charts_date_of_service ON mc_charts(date_of_service)`);

    // mc_documents indexes
    await client.query(`CREATE INDEX idx_mc_documents_chart_id ON mc_documents(chart_id)`);
    await client.query(`CREATE INDEX idx_mc_documents_transaction_id ON mc_documents(transaction_id)`);
    await client.query(`CREATE INDEX idx_mc_documents_ocr_status ON mc_documents(ocr_status)`);

    // mc_processing_queue indexes
    await client.query(`CREATE INDEX idx_mc_queue_status ON mc_processing_queue(status)`);
    await client.query(`CREATE INDEX idx_mc_queue_chart_number ON mc_processing_queue(chart_number)`);
    await client.query(`CREATE INDEX idx_mc_queue_created_at ON mc_processing_queue(created_at)`);
    await client.query(`CREATE INDEX idx_mc_queue_retry_after ON mc_processing_queue(retry_after)`);

    // mc_users indexes
    await client.query(`CREATE INDEX idx_mc_users_role ON mc_users(role)`);
    await client.query(`CREATE INDEX idx_mc_users_is_active ON mc_users(is_active)`);

    console.log('   ✅ All indexes created\n');

    // ═══════════════════════════════════════════════════════════════
    // DEFAULT ADMIN USER
    // ═══════════════════════════════════════════════════════════════
    console.log('👤 Creating default admin user...');

    const defaultPassword = 'admin123';
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    await client.query(
      `INSERT INTO mc_users (user_id, password_hash, name, role, email)
       VALUES ('admin', $1, 'System Administrator', 'admin', 'admin@medcode.ai')`,
      [passwordHash]
    );
    console.log('   ✅ Default admin user created');
    console.log('   📝 Username: admin');
    console.log('   📝 Password: admin123');
    console.log('   ⚠️  Please change the password after first login!\n');

    // ═══════════════════════════════════════════════════════════════
    // VERIFY TABLES
    // ═══════════════════════════════════════════════════════════════
    console.log('🔍 Verifying mc_ tables...');

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name LIKE 'mc_%'
      ORDER BY table_name
    `);

    console.log('   MedCode tables in database:');
    tables.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });

    console.log('\n' + '═'.repeat(50));
    console.log('✅ Database initialization completed successfully!');
    console.log('═'.repeat(50) + '\n');

  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run initialization
initDatabase();
