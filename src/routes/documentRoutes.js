import { Router } from 'express';
import { documentController } from '../controllers/documentController.js';
import { upload } from '../middleware/upload.js';

const router = Router();

// Health check
router.get('/health', documentController.healthCheck);

// Process documents - full pipeline (OCR + AI Coding + Store in DB)
router.post(
  '/process',
  upload.array('files', 20),
  documentController.processDocuments.bind(documentController)
);

export default router;
