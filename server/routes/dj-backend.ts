import { Router, type Request, type Response } from 'express';
import { getDjBackendAssessment } from '../services/dj-backend-plan.js';

const router = Router();

router.get('/plan', (_req: Request, res: Response) => {
  res.json(getDjBackendAssessment());
});

export default router;
