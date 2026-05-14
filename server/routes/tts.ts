/**
 * TTS Bridge
 *
 * Synthesizes speech immediately (CPU-heavy), then stages playback after a
 * configurable delay (default 35 s) so the stream has time to stabilise
 * before audio plays. Jobs queue up in order; files are cleaned up on exit.
 *
 * POST /api/tts/speak  — synthesize + stage for playback
 * GET  /api/tts/stream — legacy SSE stub (kept open; sends no events)
 */

import { spawn } from 'node:child_process';
import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mpvService } from '../services/mpv-service.js';
import { rateLimit } from '../utils/rate-limit.js';

const router = Router();

const LUXTTS_URL   = process.env.LUXTTS_URL  ?? 'http://127.0.0.1:5002';
const LUXTTS_VOICE = process.env.LUXTTS_VOICE ?? 'ayla';
const TTS_AUDIO_DIR = path.resolve(process.cwd(), 'dist/tts-audio');
const TTS_SINK = 'tts-audio';

const DUCK_LEVEL     = Number(process.env.TTS_DUCK_LEVEL     ?? 0.50);
// LuxTTS CPU path (onnx_modeling.py) multiplies speed by 1.3 internally.
// Send 0.77 so effective speed = 0.77 × 1.3 ≈ 1.0 (natural-pace speech).
const LUXTTS_SPEED   = Number(process.env.LUXTTS_SPEED ?? 0.77);
const UNDUCK_TAIL_MS = 400;
// Delay from synthesis completion → playback start (lets stream CPU stabilise)
const STAGE_DELAY_MS = Number(process.env.TTS_STAGE_DELAY_MS ?? 35_000);
// Max jobs held in the play queue; oldest is dropped + deleted when full
const MAX_QUEUED     = Number(process.env.TTS_MAX_QUEUED ?? 3);
// Max characters — prevents very long synthesis under CPU load
const MAX_CHARS      = Number(process.env.TTS_MAX_CHARS ?? 400);

fs.mkdir(TTS_AUDIO_DIR, { recursive: true }).catch(() => {});

// ── WAV utilities ──────────────────────────────────────────────────────────────

/**
 * Prepend silence to a PCM WAV buffer.
 * Reads the minimal header fields, inserts zero-value samples,
 * and returns a new Buffer with corrected chunk sizes.
 */
function _prependSilence(wav: Buffer, silenceMs: number): Buffer {
  if (wav.length < 44) return wav;
  const numChannels   = wav.readUInt16LE(22);
  const sampleRate    = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const bytesPerFrame = numChannels * (bitsPerSample >> 3);
  const silenceBytes  = Math.round(sampleRate * bytesPerFrame * silenceMs / 1000);

  const header = Buffer.from(wav.subarray(0, 44));
  header.writeUInt32LE(wav.readUInt32LE(40) + silenceBytes, 40); // data chunk size
  header.writeUInt32LE(wav.readUInt32LE(4)  + silenceBytes, 4);  // RIFF chunk size

  return Buffer.concat([header, Buffer.alloc(silenceBytes, 0), wav.subarray(44)]);
}

// ── Play queue ─────────────────────────────────────────────────────────────────

interface TtsJob {
  id:        string;
  filePath:  string;
  duckLevel: number;
  text:      string;
  durationMs: number;
}

const _queue: TtsJob[] = [];
let _isPlaying  = false;
let _isSpeaking = false;   // true while paplay is actually running
let _speakingText = '';
let _speakingDurationMs = 0;
let _unduckTimer: ReturnType<typeof setTimeout> | null = null;

function _enqueueJob(job: TtsJob): void {
  // Drop + delete oldest job if queue is full
  while (_queue.length >= MAX_QUEUED) {
    const dropped = _queue.shift()!;
    fs.unlink(dropped.filePath).catch(() => {});
    console.log(`[TTS] Queue full — dropped job ${dropped.id}`);
  }
  _queue.push(job);
  // Schedule play after stage delay (gives stream time to recover from synthesis CPU spike)
  setTimeout(() => _playNext(), STAGE_DELAY_MS);
  console.log(`[TTS] Job ${job.id} queued — plays in ${STAGE_DELAY_MS / 1000}s (queue depth: ${_queue.length})`);
}

function _playNext(): void {
  // Guard: if already playing, the current job's exit handler will call us
  if (_isPlaying || _queue.length === 0) return;

  const job = _queue.shift()!;
  _isPlaying = true;

  // Duck music just before playback starts
  mpvService.dispatch({ type: 'duck', targetVol: job.duckLevel, rampSecs: 0.4 });

  // Signal avatar: camera zoom + lip sync
  _isSpeaking        = true;
  _speakingText      = job.text;
  _speakingDurationMs = job.durationMs;

  const _startedAt = Date.now();
  const pp = spawn('paplay', [`--device=${TTS_SINK}`, job.filePath], {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  pp.stderr?.on('data', (d: Buffer) => {
    console.error('[TTS] paplay stderr:', d.toString().trim());
  });

  pp.on('exit', (code: number | null, signal: string | null) => {
    const elapsed = Date.now() - _startedAt;
    console.log(`[TTS] paplay exited — code=${code} signal=${signal} elapsed=${elapsed}ms job=${job.id}`);

    // Give PipeWire 600 ms to drain the last audio buffer through the monitor
    // before we unduck and start the next job.
    setTimeout(() => {
      // Signal avatar: end speaking / zoom out
      _isSpeaking        = false;
      _speakingText      = '';
      _speakingDurationMs = 0;

      // Clean up WAV file
      fs.unlink(job.filePath).catch(() => {});
      _isPlaying = false;

      // If another job is already waiting, skip the unduck — let the next job
      // keep music ducked and re-duck on its own start. This prevents the
      // unduck tail timer from firing while the next job is actively playing.
      if (_queue.length > 0) {
        if (_unduckTimer) { clearTimeout(_unduckTimer); _unduckTimer = null; }
        _playNext();
        return;
      }

      // No next job — unduck after a short tail then allow new jobs to start.
      if (_unduckTimer) clearTimeout(_unduckTimer);
      _unduckTimer = setTimeout(() => {
        mpvService.dispatch({ type: 'unduck', rampSecs: 0.8 });
        _unduckTimer = null;
        // Safe to process any job that arrived during the tail window
        _playNext();
      }, UNDUCK_TAIL_MS);
    }, 600);
  });

  pp.on('error', (e: Error) => {
    console.error('[TTS] paplay error:', e.message);
    _isSpeaking        = false;
    _speakingText      = '';
    _speakingDurationMs = 0;
    fs.unlink(job.filePath).catch(() => {});
    _isPlaying = false;
    if (_queue.length > 0) {
      // Another job is waiting — keep duck level, let next job handle unduck
      if (_unduckTimer) { clearTimeout(_unduckTimer); _unduckTimer = null; }
      _playNext();
    } else {
      // No more jobs — unduck immediately
      if (_unduckTimer) { clearTimeout(_unduckTimer); _unduckTimer = null; }
      mpvService.dispatch({ type: 'unduck', rampSecs: 0.4 });
      _playNext();
    }
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/tts/speak
 * Body: { text: string, voiceId?: string, duckLevel?: number }
 *
 * Synthesizes immediately (returns once WAV is ready), then stages playback
 * after STAGE_DELAY_MS so the stream stabilises first.
 */
// Rate limit: TTS synthesis spikes CPU on LuxTTS and writes a WAV to disk.
// 20 requests per minute per IP is generous for legitimate live-stream use
// (a watchdog Ayla-tick is ~1/min) but cuts off any feedback loop.
router.post('/speak', rateLimit({ keyPrefix: 'tts.speak', max: 20, windowMs: 60_000 }), async (req: Request, res: Response) => {
  const { text, voiceId, duckLevel } = req.body as {
    text?: string;
    voiceId?: string;
    duckLevel?: number;
  };

  if (!text?.trim()) {
    res.status(400).json({ ok: false, error: 'text required' });
    return;
  }

  // Strip markdown and emojis so they don't get spoken aloud
  const clean = text.trim()
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')  // *italic* **bold** ***bold-italic***
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')     // _italic_ __bold__
    .replace(/`([^`]+)`/g, '$1')               // `code`
    .replace(/#+\s*/g, '')                     // # headings
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [link](url)
    .replace(/\p{Emoji_Presentation}/gu, '')   // strip emoji glyphs (🎧 etc.)
    .replace(/  +/g, ' ')                       // collapse extra spaces
    .trim();

  if (clean.trim().length > MAX_CHARS) {
    res.status(400).json({
      ok: false,
      error: `Text too long (${text.trim().length} chars) — keep under ${MAX_CHARS} for live streaming`,
    });
    return;
  }

  try {
    // ── 1. Synthesize (CPU spike happens here) ─────────────────────────────────
    const luxRes = await fetch(`${LUXTTS_URL}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: clean, voice_id: voiceId ?? LUXTTS_VOICE, speed: LUXTTS_SPEED }),
      signal:  AbortSignal.timeout(90_000),
    });

    if (!luxRes.ok) {
      throw new Error(`LuxTTS error ${luxRes.status}: ${await luxRes.text()}`);
    }

    const wavBytes = await luxRes.arrayBuffer();
    const id       = randomUUID();
    const filePath = path.join(TTS_AUDIO_DIR, `tts-${id}.wav`);
    // Prepend 300ms silence: PipeWire needs a moment to initialise the stream;
    // without it the first ~150ms of speech is dropped/garbled on the monitor output.
    const wavWithSilence = _prependSilence(Buffer.from(wavBytes), 300);
    await fs.writeFile(filePath, wavWithSilence);

    // Estimate duration from WAV header (LuxTTS outputs mono 16-bit 48kHz = 96000 bytes/sec)
    const wavBuf = Buffer.from(wavBytes);
    const sr   = wavBuf.length >= 28 ? wavBuf.readUInt32LE(24) : 48000;
    const ch   = wavBuf.length >= 24 ? wavBuf.readUInt16LE(22) : 1;
    const bits = wavBuf.length >= 36 ? wavBuf.readUInt16LE(34) : 16;
    const bytesPerSec = sr * ch * (bits >> 3);
    const durationMs = Math.round((wavBytes.byteLength / bytesPerSec) * 1000);

    // ── 2. Queue for staged playback ───────────────────────────────────────────
    const level = typeof duckLevel === 'number' ? duckLevel : DUCK_LEVEL;
    _enqueueJob({ id, filePath, duckLevel: level, text: clean, durationMs });

    res.json({ ok: true, id, durationMs, stageDelayMs: STAGE_DELAY_MS, queued: _queue.length + (_isPlaying ? 1 : 0) });
  } catch (err) {
    console.error('[TTS] Synthesis failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** GET /api/tts/state — avatar polling endpoint */
router.get('/state', (_req: Request, res: Response) => {
  res.json({
    isSpeaking:  _isSpeaking,
    text:        _isSpeaking ? _speakingText : null,
    durationMs:  _isSpeaking ? _speakingDurationMs : 0,
    queued:      _queue.length,
    playing:     _isPlaying,
  });
});

/** GET /api/tts/clients — subscriber count (debug) */
router.get('/clients', (_req: Request, res: Response) => {
  res.json({ clients: 0, queued: _queue.length, playing: _isPlaying });
});

/**
 * GET /api/tts/stream — SSE stub (legacy)
 * Kept so existing browser connections don't error. No events are sent.
 */
const _ttsClients = new Set<Response>();
router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  _ttsClients.add(res);
  req.on('close', () => { _ttsClients.delete(res); });
});

export default router;
