import { Router } from 'express';
import documentRoutes from './documentRoutes.js';
import chartRoutes from './chartRoutes.js';

const router = Router();

router.use('/documents', documentRoutes);
router.use('/charts', chartRoutes);

router.get('/', (req, res) => {
  res.json({
    service: 'MedCode AI Backend',
    version: '1.0.0',
    endpoints: {
      documents: {
        process: 'POST /api/documents/process',
        health: 'GET /api/documents/health'
      },
      charts: {
        list: 'GET /api/charts',
        get: 'GET /api/charts/:chartNumber',
        updateStatus: 'PATCH /api/charts/:chartNumber/status',
        delete: 'DELETE /api/charts/:chartNumber',
        slaStats: 'GET /api/charts/stats/sla',
        facilities: 'GET /api/charts/filters/facilities',
        specialties: 'GET /api/charts/filters/specialties'
      }
    }
  });
});

export default router;
