/**
 * Chat Routes
 *
 * GET  /api/chat/stream   — SSE stream of live chat messages
 * GET  /api/chat/status   — config and pool status
 * POST /api/chat/config   — set YouTube API key + live chat ID at runtime
 */

import { Router, type Request, type Response } from 'express';
import { youtubeChatService } from '../services/youtube-chat.js';
import { chatOrchestrator } from '../services/chat-orchestrator.js';

const router = Router();

// ── SSE stream ────────────────────────────────────────────────────────────────

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if proxied
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  youtubeChatService.addClient(send);

  // Keep-alive comment every 25s (prevents proxy timeout)
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    youtubeChatService.removeClient(send);
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    configured: youtubeChatService.isConfigured,
    poolSize: youtubeChatService.poolSize,
    clients: youtubeChatService.clientCount,
    quotaBlocked: youtubeChatService.lastQuotaErrorAt > 0,
    lastQuotaErrorAt: youtubeChatService.lastQuotaErrorAt,
    moderation: chatOrchestrator.getStatus(),
  });
});

// ── Test API key (no chat ID needed) ─────────────────────────────────────────

router.get('/test-key', async (req: Request, res: Response) => {
  const apiKey = req.query['apiKey'] as string | undefined;

  if (!apiKey) {
    res.status(400).json({ ok: false, error: 'apiKey query param required' });
    return;
  }

  try {
    // i18nLanguages is a 1-unit read-only call — cheapest valid YouTube API request
    const url = `https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&key=${encodeURIComponent(apiKey)}`;
    const ytRes = await fetch(url);
    const body = await ytRes.json() as { error?: { message?: string; status?: string } };

    if (!ytRes.ok) {
      const msg = body.error?.message ?? `HTTP ${ytRes.status}`;
      res.json({ ok: false, error: msg });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String(err) });
  }
});

// ── Runtime configuration ─────────────────────────────────────────────────────

router.post('/config', (req: Request, res: Response) => {
  const { apiKey, liveChatId } = req.body as { apiKey?: string; liveChatId?: string };

  if (!apiKey || !liveChatId) {
    res.status(400).json({ error: 'apiKey and liveChatId are required' });
    return;
  }

  youtubeChatService.configure(apiKey, liveChatId);
  res.json({ ok: true, message: 'YouTube chat polling started' });
});

// ── Chat outbound ─────────────────────────────────────────────────────────────

/**
 * POST /api/chat/send
 * Body: { text: string }
 * Posts a message to the YouTube live chat as the channel owner.
 * Rate-limited to 1 per 20s. Returns ok:false if not live or not authorized.
 */
router.post('/send', async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) {
    res.status(400).json({ ok: false, error: 'text required' });
    return;
  }
  const ok = await youtubeChatService.sendChatMessage(text.trim());
  res.json({ ok });
});

// ── Mood signal ───────────────────────────────────────────────────────────────

/**
 * GET /api/chat/mood
 * Keyword analysis of recent chat messages — returns energy signal and top genre mentions.
 */
router.get('/mood', (_req: Request, res: Response) => {
  res.json(youtubeChatService.getChatMood());
});

export default router;
