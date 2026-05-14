import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TrackStore } from '../utils/music-scanner.js';

const router = Router();

/** MIME types for supported audio formats */
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
};

// ── GET /api/tracks/stats ─────────────────────────────────────

router.get('/stats', (_req: Request, res: Response) => {
  const store = TrackStore.getInstance();
  const all = store.getAll();
  const byGenre: Record<string, number> = {};
  for (const t of all) {
    const g = t.genre?.toLowerCase().trim() || 'unknown';
    byGenre[g] = (byGenre[g] ?? 0) + 1;
  }
  const thin = Object.entries(byGenre)
    .filter(([, count]) => count < 5)
    .map(([genre]) => genre);
  res.json({ total: all.length, byGenre, thin });
});

// ── GET /api/tracks ──────────────────────────────────────────

router.get('/', (_req: Request, res: Response) => {
  const store = TrackStore.getInstance();
  const tracks = store.getAll().map(({ filePath, ...rest }) => rest);
  res.json(tracks);
});

// ── GET /api/tracks/:id/stream ───────────────────────────────

router.get('/:id/stream', async (req: Request, res: Response) => {
  const store = TrackStore.getInstance();
  const track = store.getById(req.params.id as string);

  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  try {
    const stat = await fsp.stat(track.filePath);
    const fileSize = stat.size;
    const mimeType = MIME_TYPES[track.format] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      // ── Range request (seeking) ──────────────────────────
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        return;
      }

      const chunkSize = end - start + 1;

      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': mimeType,
      });

      const stream = fs.createReadStream(track.filePath, { start, end });
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      // ── Full file request ────────────────────────────────
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize),
        'Content-Type': mimeType,
      });

      const stream = fs.createReadStream(track.filePath);
      stream.pipe(res);
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
    }
  } catch (err) {
    console.error(`[tracks] Stream error for ${track.filePath}:`, (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream file' });
    }
  }
});

export default router;
