import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import routes from './routes/index.js';
import { pool } from './db/connection.js';

const app = express();

// Middleware
app.use(cors(
));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.url.includes('/api/charts')) {
    console.log(`📨 ${req.method} ${req.url}`);
  }
  next();
});

// Routes
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({
    message: 'MedCode AI Backend',
    api: '/api'
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('❌ Error:', error.message);

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'File too large (max 25MB)' });
  }

  res.status(500).json({ success: false, error: error.message });
});

// Test database connection and start server
async function startServer() {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    // Start server
    app.listen(config.port, () => {
      console.log('\n' + '═'.repeat(50));
      console.log('🏥 MedCode AI Backend');
      console.log('═'.repeat(50));
      console.log(`🚀 Server: http://localhost:${config.port}`);
      console.log(`📡 API: http://localhost:${config.port}/api`);
      console.log(`🔗 OCR: ${config.ocr.serviceUrl}`);
      console.log(`🤖 AI Model: ${config.ai.model}`);
      console.log(`📦 Database: Connected`);
      console.log('═'.repeat(50) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

export default app;
