/**
 * Broadcast Scheduler Routes
 *
 * GET  /api/scheduler/state          — current scheduler state + next stream
 * GET  /api/scheduler/schedule       — full weekly schedule
 * POST /api/scheduler/schedule       — add a new schedule entry
 * PUT  /api/scheduler/schedule/:id   — update an entry
 * DELETE /api/scheduler/schedule/:id — remove an entry
 * POST /api/scheduler/start          — trigger stream manually (no schedule needed)
 * POST /api/scheduler/end            — end current stream immediately
 */

import { safeErrorMessage } from '../utils/error-response.js';
import { Router, type Request, type Response } from 'express';
import { broadcastScheduler, type ScheduleEntry } from '../services/broadcast-scheduler.js';

const router = Router();

// ── State ──────────────────────────────────────────────────────────────────────

router.get('/state', (_req: Request, res: Response) => {
  res.json(broadcastScheduler.state);
});

// ── Schedule CRUD ──────────────────────────────────────────────────────────────

router.get('/schedule', (_req: Request, res: Response) => {
  res.json(broadcastScheduler.getSchedule());
});

router.post('/schedule', (req: Request, res: Response) => {
  const body = req.body as Partial<Omit<ScheduleEntry, 'id'>>;

  if (!body.title || !body.days || body.startHH === undefined || body.startMM === undefined || !body.durationMins) {
    res.status(400).json({ error: 'title, days, startHH, startMM, durationMins are required' });
    return;
  }

  const entry = broadcastScheduler.addEntry({
    title:        body.title,
    description:  body.description ?? '',
    days:         body.days,
    startHH:      body.startHH,
    startMM:      body.startMM,
    durationMins: body.durationMins,
    enabled:      body.enabled ?? true,
  });

  res.status(201).json(entry);
});

router.put('/schedule/:id', (req: Request, res: Response) => {
  const entry = broadcastScheduler.updateEntry(String(req.params.id), req.body as Partial<Omit<ScheduleEntry, 'id'>>);
  if (!entry) {
    res.status(404).json({ error: 'Entry not found' });
    return;
  }
  res.json(entry);
});

router.delete('/schedule/:id', (req: Request, res: Response) => {
  const deleted = broadcastScheduler.deleteEntry(String(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: 'Entry not found' });
    return;
  }
  res.json({ ok: true });
});

// ── Manual control ─────────────────────────────────────────────────────────────

router.post('/start', async (req: Request, res: Response) => {
  const { title, durationMins, description } = req.body as {
    title?: string;
    durationMins?: number;
    description?: string;
  };

  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  if (broadcastScheduler.state.status !== 'idle') {
    res.status(409).json({ error: `Scheduler is busy: ${broadcastScheduler.state.status}` });
    return;
  }

  // Kick off async — respond immediately, client polls /state
  void broadcastScheduler.startNow(title, durationMins ?? 60, description ?? '');
  res.json({ ok: true, message: 'Stream start initiated — poll /api/scheduler/state for progress' });
});

router.post('/end', async (_req: Request, res: Response) => {
  try {
    await broadcastScheduler.endNow();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

export default router;
