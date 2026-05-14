import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/settings/defaults
 * Returns credentials stored in the server .env so the frontend
 * can restore them if localStorage was cleared.
 */
router.get('/defaults', (_req: Request, res: Response) => {
  res.json({
    apiKey:       process.env.YOUTUBE_API_KEY       || '',
    channelId:    process.env.YOUTUBE_CHANNEL_ID    || '',
    clientId:     process.env.YOUTUBE_CLIENT_ID     || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    obsUrl:       process.env.OBS_WS_URL            || 'ws://localhost:4455',
    obsPassword:  process.env.OBS_WS_PASSWORD       || process.env.OBS_PASSWORD || '',
  });
});

export default router;
