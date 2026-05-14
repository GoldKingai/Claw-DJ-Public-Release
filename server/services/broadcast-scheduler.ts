/**
 * Broadcast Scheduler
 *
 * Orchestrates the full automated stream lifecycle.
 *
 * OBS is pre-authenticated with YouTube and manages its own RTMP connection —
 * no credential injection needed. The scheduler simply:
 *
 *   1. At scheduled start time:
 *      a. Tell OBS to start streaming via WebSocket
 *      b. Poll the YouTube stream detector until the channel shows as live
 *         (OBS creates the broadcast + stream on YouTube automatically)
 *      c. Mark scheduler status as "live"
 *
 *   2. At scheduled end time (or after durationMins):
 *      a. Tell OBS to stop streaming
 *      b. Reset to idle
 *
 *   3. On error — stop OBS, log, reset to idle.
 *
 * Schedules are persisted to server/data/schedule.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { obsController } from './obs-controller.js';
import { youtubeStreamDetector } from './youtube-stream-detector.js';
import { sessionManager } from './session-manager.js';
import { djLocalEngine } from './dj-local-engine.js';
import { scheduleXAnnouncement, fireStreamStart } from './watchdog.js';
import { flowPost } from './x-poster.js';
import { notifyWarn, notifyError, notifySuccess } from './discord-notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE_FILE = path.join(
  __dirname,
  '../data/schedule.json'
);
const STREAM_STATS_FILE = path.join(__dirname, '../data/stream-stats.json');

// ── Types ─────────────────────────────────────────────────────────────────────

/** 0 = Sunday … 6 = Saturday (matches JS Date.getDay()) */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ScheduleEntry {
  id:           string;
  title:        string;        // YouTube broadcast title
  description?: string;
  days:         Weekday[];     // which days of the week
  startHH:      number;        // 0–23 local time
  startMM:      number;        // 0–59
  durationMins: number;        // stream length in minutes
  enabled:      boolean;
}

export type SchedulerStatus =
  | 'idle'
  | 'creating'    // creating YouTube broadcast + stream
  | 'warming'     // OBS streaming, waiting for YouTube health
  | 'live'        // broadcast is live on YouTube
  | 'ending'      // transitioning to complete
  | 'error';

export interface SchedulerState {
  status:       SchedulerStatus;
  activeEntry:  ScheduleEntry | null;
  broadcastId:  string;
  rtmpUrl:      string;
  streamKey:    string;
  startedAt:    number;   // ms epoch, 0 if not live
  endsAt:       number;   // ms epoch, 0 if not live
  lastError:    string;
  nextStream:   { entry: ScheduleEntry; startsAt: number } | null;
}

// ── Stream stats ─────────────────────────────────────────────────────────────

interface StreamStats {
  streamId:         string;
  title:            string;
  startedAt:        number;
  endedAt:          number;
  durationMins:     number;
  peakViewers:      number;
  genresPlayed:     string[];
  tracksPlayed:     number;
}

// ── Service ───────────────────────────────────────────────────────────────────

class BroadcastScheduler {
  private _schedule: ScheduleEntry[] = [];
  private _state: SchedulerState = {
    status:      'idle',
    activeEntry: null,
    broadcastId: '',
    rtmpUrl:     '',
    streamKey:   '',
    startedAt:   0,
    endsAt:      0,
    lastError:   '',
    nextStream:  null,
  };

  private _tickTimer:     ReturnType<typeof setInterval> | null = null;
  private _healthTimer:   ReturnType<typeof setInterval> | null = null;
  private _liveHealthTimer: ReturnType<typeof setInterval> | null = null;
  private _endTimer:      ReturnType<typeof setTimeout>  | null = null;
  private _sessionRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _xAnnouncementScheduledFor: number | null = null;

  // ── Live health monitor state ────────────────────────────────────────────
  private _lastAudioActivityAt = 0;
  private _lastAudioPosition: number | null = null;
  private _frozenPositionCount = 0;
  private _obsDropCount = 0;

  // ── Stream statistics ─────────────────────────────────────────────────────────
  private _streamStats: StreamStats[] = [];
  private _currentStreamStats: Partial<StreamStats> | null = null;

  // ── Init ─────────────────────────────────────────────────────────────────────

  start(): void {
    this._loadSchedule();
    this._loadStreamStats();
    // Tick every 30 s to check if a stream should start
    this._tickTimer = setInterval(() => this._tick(), 30_000);
    this._tick(); // immediate
    console.log('[Scheduler] Started — checking schedule every 30 s');
  }

  stop(): void {
    if (this._tickTimer)      clearInterval(this._tickTimer);
    if (this._healthTimer)    clearInterval(this._healthTimer);
    if (this._liveHealthTimer) clearInterval(this._liveHealthTimer);
    if (this._endTimer)       clearTimeout(this._endTimer);
    if (this._sessionRefreshTimer) { clearInterval(this._sessionRefreshTimer); this._sessionRefreshTimer = null; }
    this._tickTimer = this._healthTimer = this._liveHealthTimer = this._endTimer = null;
  }

  // ── Schedule CRUD ─────────────────────────────────────────────────────────────

  getSchedule(): ScheduleEntry[] {
    return this._schedule;
  }

  addEntry(entry: Omit<ScheduleEntry, 'id'>): ScheduleEntry {
    const newEntry: ScheduleEntry = { ...entry, id: `sched_${Date.now()}` };
    this._schedule.push(newEntry);
    this._saveSchedule();
    this._updateNextStream();
    return newEntry;
  }

  updateEntry(id: string, patch: Partial<Omit<ScheduleEntry, 'id'>>): ScheduleEntry | null {
    const idx = this._schedule.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    this._schedule[idx] = { ...this._schedule[idx], ...patch };
    this._saveSchedule();
    this._updateNextStream();
    return this._schedule[idx];
  }

  deleteEntry(id: string): boolean {
    const before = this._schedule.length;
    this._schedule = this._schedule.filter((e) => e.id !== id);
    if (this._schedule.length !== before) {
      this._saveSchedule();
      this._updateNextStream();
      return true;
    }
    return false;
  }

  // ── State ─────────────────────────────────────────────────────────────────────

  get state(): SchedulerState {
    // If we hit an OBS-related error but OBS is no longer connected, surface that.
    // If the previous OBS error condition has been resolved and we're otherwise idle,
    // don't keep reporting a stale scheduler fault forever.
    let derivedStatus = this._state.status;
    let derivedLastError = this._state.lastError;

    if (
      this._state.status === 'error' &&
      this._state.activeEntry === null &&
      !obsController.isConnected &&
      /OBS not connected/i.test(this._state.lastError)
    ) {
      derivedStatus = 'idle';
      derivedLastError = '';
    }

    return { ...this._state, status: derivedStatus, lastError: derivedLastError };
  }

  // ── Manual trigger ────────────────────────────────────────────────────────────

  async startNow(title: string, durationMins = 60, description = ''): Promise<void> {
    const entry: ScheduleEntry = {
      id:          `manual_${Date.now()}`,
      title,
      description,
      days:        [],
      startHH:     0,
      startMM:     0,
      durationMins,
      enabled:     false,
    };
    await this._runStream(entry);
  }

  async endNow(): Promise<void> {
    if (this._state.status !== 'live' && this._state.status !== 'warming') {
      throw new Error('No active stream to end');
    }
    await this._endStream();
  }

  // ── Internal: tick ────────────────────────────────────────────────────────────

  private _tick(): void {
    this._updateNextStream();

    // Schedule X pre-live announcements up to 90 mins before stream
    const ns = this._state.nextStream;
    if (ns && ns.startsAt !== this._xAnnouncementScheduledFor) {
      const minsUntil = (ns.startsAt - Date.now()) / 60_000;
      if (minsUntil <= 90 && minsUntil > 5) {
        this._xAnnouncementScheduledFor = ns.startsAt;
        scheduleXAnnouncement(ns.startsAt);
      }
    }

    if (this._state.status !== 'idle') return; // already running something

    const now   = new Date();
    const today = now.getDay() as Weekday;
    const hh    = now.getHours();
    const mm    = now.getMinutes();

    for (const entry of this._schedule) {
      if (!entry.enabled)            continue;
      if (!entry.days.includes(today)) continue;
      if (entry.startHH !== hh)      continue;
      if (Math.abs(entry.startMM - mm) > 1) continue; // within 1 min

      console.log(`[Scheduler] Triggering scheduled stream: "${entry.title}"`);
      void this._runStream(entry);
      return;
    }
  }

  // ── Internal: full stream run ─────────────────────────────────────────────────

  private async _runStream(entry: ScheduleEntry): Promise<void> {
    // ── Pre-stream checklist ─────────────────────────────────────────────────
    const checklistOk = await this._runPreStreamChecklist();
    if (!checklistOk) {
      this._setError('Pre-stream checklist failed — see Discord for details');
      return;
    }

    try {
      // ── Step 1: Tell OBS to start streaming (3 attempts with backoff) ─────────
      // OBS is pre-authenticated with YouTube and manages its own RTMP key.
      // It will create the YouTube broadcast automatically.
      this._setState({ status: 'creating', activeEntry: entry, lastError: '' });
      console.log(`[Scheduler] Starting OBS stream for: "${entry.title}"`);

      const OBS_RETRY_DELAYS_MS = [0, 5_000, 15_000]; // retry after 5s then 15s
      let obsStarted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await obsController.startStreaming();
          obsStarted = true;
          break;
        } catch (err) {
          console.warn(`[Scheduler] OBS start attempt ${attempt}/3 failed: ${err}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, OBS_RETRY_DELAYS_MS[attempt]));
          }
        }
      }
      if (!obsStarted) {
        throw new Error('OBS start failed after 3 attempts');
      }

      // Generate night plan and kick off first session
      const currentHour = new Date().getHours();
      const nightPlan = sessionManager.generateNightPlan(entry.durationMins, currentHour);
      if (nightPlan.length > 0) {
        sessionManager.setPlan(nightPlan);
        sessionManager.start(
          nightPlan[0].genre,
          nightPlan[0].durationMins,
          nightPlan[1]?.genre ?? null,
          nightPlan,
          0,
        );
        const planStr = nightPlan.map(p => p.genre + '(' + p.durationMins + 'm)').join(' -> ');
        console.log('[Scheduler] Night plan: ' + planStr);
      }

      this._setState({ status: 'warming' });
      console.log('[Scheduler] OBS streaming — waiting for YouTube to confirm live');

      // ── Step 2: Wait for YouTube stream detector to see the channel go live ────
      await this._waitForYouTubeLive();

      // ── Step 3: Mark live, schedule end ───────────────────────────────────────
      const startedAt = Date.now();
      const endsAt    = 0; // 24/7 — no scheduled end

      this._setState({ status: 'live', startedAt, endsAt });
      console.log('[Scheduler] LIVE — will end in ' + entry.durationMins + ' min');

      // Start live health monitor (dead-air + OBS drop detection, every 15s)
      this._startLiveHealthMonitor();

      // Begin tracking stream stats
      this._currentStreamStats = {
        streamId:     'stream_' + startedAt,
        title:         entry.title,
        startedAt,
        peakViewers:   0,
        genresPlayed:  [],
        tracksPlayed:  0,
      };

      // Fire welcome sequence + go-live X post
      fireStreamStart();
      void flowPost(
        'x-scheduler: we just went live on YouTube! Post a hype go-live tweet as Flow. ' +
        'Include the channel link https://youtube.com/@FlowDJ. ' +
        'Short, excited, in character. Max 280 chars. Max 2-3 tags.'
      ).catch(() => {});

      // 24/7 mode: no end timer — stream runs until manually ended or OBS drops.
      this._startSessionRefreshMonitor(entry);

    } catch (err) {
      console.error('[Scheduler] Stream run failed:', err);
      this._setError(err instanceof Error ? err.message : String(err));
      await this._cleanup().catch(() => {});
    }
  }

  // ── Internal: end stream ──────────────────────────────────────────────────────

  private async _endStream(): Promise<void> {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._liveHealthTimer) { clearInterval(this._liveHealthTimer); this._liveHealthTimer = null; }
    if (this._sessionRefreshTimer) { clearInterval(this._sessionRefreshTimer); this._sessionRefreshTimer = null; }
    this._lastAudioActivityAt = 0;
    this._lastAudioPosition = null;
    this._frozenPositionCount = 0;
    this._obsDropCount = 0;

    this._setState({ status: 'ending' });
    console.log('[Scheduler] Ending stream — graceful fade-out');

    // ── Graceful fade-out sequence ─────────────────────────────────────────────
    try {
      // 1. Fade music to silence over 8 seconds
      await fetch('http://localhost:3001/api/playback/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'fade-to', payload: { volume: 0, rampSecs: 8 } }),
      });
      // 2. Wait for fade to complete
      await new Promise(r => setTimeout(r, 8_500));
      // 3. Stop the engine
      await fetch('http://localhost:3001/api/playback/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'stop' }),
      });
      // 4. Brief gap before OBS stop
      await new Promise(r => setTimeout(r, 5_000));
    } catch { /* non-fatal — always proceed to OBS stop */ }

    // ── Save stream stats before cleanup ──────────────────────────────────────
    this._finaliseStreamStats();

    await this._cleanup();

    this._setState({
      status:      'idle',
      activeEntry: null,
      broadcastId: '',
      rtmpUrl:     '',
      streamKey:   '',
      startedAt:   0,
      endsAt:      0,
    });
    sessionManager.end();
    console.log('[Scheduler] Stream ended — back to idle');
    this._updateNextStream();
  }

  // ── Internal: cleanup ─────────────────────────────────────────────────────────

  private async _cleanup(): Promise<void> {
    await obsController.stopStreaming().catch(() => {});
  }

  // ── Pre-stream checklist ─────────────────────────────────────────────────────

  private async _runPreStreamChecklist(): Promise<boolean> {
    type Check = { name: string; pass: boolean; detail?: string };
    const checks: Check[] = [];

    // 1. OBS connected
    checks.push({ name: 'OBS connected', pass: obsController.isConnected });

    // 2. Music library has enough tracks
    const stats = sessionManager.getStats();
    checks.push({ name: 'Music library', pass: stats.total >= 5, detail: stats.total + ' tracks' });

    // 3. mpv audio engine connected
    let engineOk = false;
    try {
      const es = await djLocalEngine.refreshWorkerState();
      engineOk = es.workerConnected;
    } catch { /* engine not available */ }
    checks.push({ name: 'mpv engine', pass: engineOk });

    // 4. TTS service responsive
    let ttsOk = false;
    try {
      const res = await fetch('http://localhost:5002/', { signal: AbortSignal.timeout(3_000) });
      ttsOk = res.status < 500;
    } catch { /* TTS not responding */ }
    checks.push({ name: 'TTS service (luxtts)', pass: ttsOk });

    // 5. Session manager idle (no orphan session from previous stream)
    const session = sessionManager.snapshot();
    checks.push({
      name:   'Session state',
      pass:   session.status === 'idle',
      detail: session.status === 'idle' ? 'idle' : 'active (' + session.genre + ')',
    });

    const failed = checks.filter(c => !c.pass);
    const allPassed = failed.length === 0;

    if (allPassed) {
      console.log('[Scheduler] Pre-stream checklist: all ' + checks.length + ' checks passed ✓');
    } else {
      const failList = failed.map(c => c.name + (c.detail ? ' (' + c.detail + ')' : '')).join(', ');
      console.error('[Scheduler] Pre-stream checklist FAILED: ' + failList);
      await notifyError(
        'Pre-stream checklist failed — stream aborted.\n\nFailed checks: ' + failList,
        {
          title: 'Stream Aborted',
          fields: checks.map(c => ({
            name:   c.name + (c.detail ? ' (' + c.detail + ')' : ''),
            value:  c.pass ? '✅ Pass' : '❌ Fail',
            inline: true,
          })),
        }
      ).catch(() => {});
    }

    return allPassed;
  }

  // ── Live health monitor ───────────────────────────────────────────────────────

  private _startLiveHealthMonitor(): void {
    if (this._liveHealthTimer) clearInterval(this._liveHealthTimer);
    this._lastAudioActivityAt = Date.now(); // assume audio starts immediately
    this._lastAudioPosition = null;
    this._frozenPositionCount = 0;
    this._obsDropCount = 0;
    this._liveHealthTimer = setInterval(() => {
      void this._checkLiveHealth();
    }, 15_000);
  }

  private async _checkLiveHealth(): Promise<void> {
    if (this._state.status !== 'live') return;

    // ── OBS connectivity check ────────────────────────────────────────────────
    if (!obsController.isConnected) {
      this._obsDropCount++;
      console.warn(`[Scheduler] OBS disconnected (tick ${this._obsDropCount}/2)`);
      if (this._obsDropCount >= 2) {
        this._obsDropCount = 0;
        await this._handleStreamDrop();
      }
      return;
    }
    this._obsDropCount = 0;

    // ── Dead-air / frozen position check ─────────────────────────────────────
    try {
      const es = await djLocalEngine.refreshWorkerState();
      const positionSeconds = es.workerState?.positionSeconds ?? null;

      if (es.workerConnected && es.currentTrackId && es.mode === 'playing') {
        // Check for frozen position (mpv hang)
        if (positionSeconds !== null && positionSeconds === this._lastAudioPosition) {
          this._frozenPositionCount++;
          if (this._frozenPositionCount >= 3) {
            console.warn('[Scheduler] Audio position frozen — possible mpv hang');
            await notifyWarn(
              'Audio position frozen for ~45s at ' + (positionSeconds?.toFixed(1) ?? '?') + 's — possible mpv hang',
              { title: 'Audio Freeze', fields: [{ name: 'Genre', value: sessionManager.snapshot().genre || 'unknown', inline: true }] }
            ).catch(() => {});
            this._frozenPositionCount = 0;
          }
        } else {
          this._frozenPositionCount = 0;
        }
        this._lastAudioPosition = positionSeconds;
        this._lastAudioActivityAt = Date.now();
      } else if (this._lastAudioActivityAt > 0) {
        // Engine idle or disconnected while stream is live
        const silenceSecs = Math.round((Date.now() - this._lastAudioActivityAt) / 1000);
        if (silenceSecs >= 45) {
          console.warn('[Scheduler] Dead air: no audio for ' + silenceSecs + 's (mode=' + es.mode + ')');
          await notifyWarn(
            'Dead air — no audio activity for ' + silenceSecs + 's. Engine mode: ' + es.mode,
            {
              title: 'Dead Air Alert',
              fields: [
                { name: 'Engine connected', value: String(es.workerConnected), inline: true },
                { name: 'Track', value: es.currentTrackId ?? 'none', inline: true },
              ],
            }
          ).catch(() => {});
          this._lastAudioActivityAt = Date.now(); // reset to avoid repeat alerts every 15s
        }
      }
    } catch {
      // Engine check failure is non-fatal for health monitor
    }
  }

  private async _handleStreamDrop(): Promise<void> {
    console.error('[Scheduler] Stream drop — OBS disconnected during live stream');
    await notifyError('OBS disconnected during live stream — attempting reconnect', {
      title: 'Stream Drop',
    }).catch(() => {});

    // Two reconnect attempts with 10s gap
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await obsController.connect();
        console.log('[Scheduler] OBS reconnected on attempt ' + attempt);
        await notifySuccess('OBS reconnected (attempt ' + attempt + '/2) — stream resuming', {
          title: 'Stream Recovered',
        }).catch(() => {});
        return;
      } catch (err) {
        console.warn('[Scheduler] OBS reconnect attempt ' + attempt + '/2 failed:', err);
        if (attempt < 2) await new Promise(r => setTimeout(r, 10_000));
      }
    }

    // All reconnects failed
    console.error('[Scheduler] OBS reconnect failed — stream likely down');
    await notifyError(
      'OBS reconnect failed after 2 attempts. Stream is likely down. Manual intervention needed.',
      { title: 'Stream Recovery Failed', fields: [{ name: 'Action', value: 'Manual restart required', inline: false }] }
    ).catch(() => {});
    this._setError('OBS disconnected during live stream — reconnect failed');
  }

  // ── Stream stats helpers ─────────────────────────────────────────────────────

  private _finaliseStreamStats(): void {
    if (!this._currentStreamStats?.startedAt) return;
    const endedAt = Date.now();
    const session = sessionManager.snapshot();
    const stats: StreamStats = {
      streamId:     this._currentStreamStats.streamId ?? 'stream_' + endedAt,
      title:         this._currentStreamStats.title ?? '',
      startedAt:     this._currentStreamStats.startedAt,
      endedAt,
      durationMins:  Math.round((endedAt - this._currentStreamStats.startedAt) / 60_000),
      peakViewers:   this._currentStreamStats.peakViewers ?? 0,
      genresPlayed:  this._currentStreamStats.genresPlayed ?? [],
      tracksPlayed:  session.tracksPlayedIds?.length ?? 0,
    };
    this._streamStats.push(stats);
    if (this._streamStats.length > 100) this._streamStats = this._streamStats.slice(-100);
    this._currentStreamStats = null;
    this._saveStreamStats();
    console.log('[Scheduler] Stream stats saved: ' + stats.durationMins + 'min, ' + stats.peakViewers + ' peak viewers');
  }

  private _saveStreamStats(): void {
    try {
      const dir = path.dirname(STREAM_STATS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STREAM_STATS_FILE, JSON.stringify(this._streamStats, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Scheduler] Could not save stream stats:', err);
    }
  }

  private _loadStreamStats(): void {
    try {
      if (fs.existsSync(STREAM_STATS_FILE)) {
        const raw = fs.readFileSync(STREAM_STATS_FILE, 'utf-8');
        this._streamStats = JSON.parse(raw) as StreamStats[];
        console.log('[Scheduler] Loaded ' + this._streamStats.length + ' stream stats entries');
      }
    } catch {
      this._streamStats = [];
    }
  }

  /** Returns the full stream stats history. */
  getStreamStats(): StreamStats[] {
    return [...this._streamStats];
  }

  // ── Internal: wait for YouTube to detect the stream as live ──────────────────

  // Uses the existing stream detector (polls YouTube search.list every 60 s).
  // Resolves when the channel shows as live, rejects after 5 min timeout.

  private _waitForYouTubeLive(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already live? (detector may have caught it from a previous poll)
      if (youtubeStreamDetector.status.isLive) { resolve(); return; }

      const MAX_WAIT_MS = 5 * 60_000; // 5 min
      const POLL_MS     = 15_000;     // check every 15 s
      let   elapsed     = 0;

      this._healthTimer = setInterval(() => {
        elapsed += POLL_MS;

        if (youtubeStreamDetector.status.isLive) {
          clearInterval(this._healthTimer!);
          this._healthTimer = null;
          resolve();
          return;
        }

        if (elapsed >= MAX_WAIT_MS) {
          clearInterval(this._healthTimer!);
          this._healthTimer = null;
          // Don't hard-fail — OBS might be streaming fine even if detector hasn't caught it yet
          console.warn('[Scheduler] YouTube live detection timed out — marking live anyway');
          resolve();
        }
      }, POLL_MS);
    });
  }

  // ── Internal: next stream calculator ─────────────────────────────────────────

  private _updateNextStream(): void {
    const now = Date.now();
    let   soonest: { entry: ScheduleEntry; startsAt: number } | null = null;

    for (const entry of this._schedule) {
      if (!entry.enabled) continue;

      // Check next 7 days for matching days
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const candidate = new Date(now + dayOffset * 86_400_000);
        if (!entry.days.includes(candidate.getDay() as Weekday)) continue;

        candidate.setHours(entry.startHH, entry.startMM, 0, 0);
        const ms = candidate.getTime();
        if (ms <= now) continue; // already passed today

        if (!soonest || ms < soonest.startsAt) {
          soonest = { entry, startsAt: ms };
        }
        break; // found the next occurrence for this entry
      }
    }

    this._setState({ nextStream: soonest });
  }

  // ── Internal: file persistence ────────────────────────────────────────────────

  private _loadSchedule(): void {
    try {
      if (fs.existsSync(SCHEDULE_FILE)) {
        const raw = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
        this._schedule = JSON.parse(raw) as ScheduleEntry[];
        console.log(`[Scheduler] Loaded ${this._schedule.length} schedule entries`);
      } else {
        console.log('[Scheduler] No schedule file found — starting empty');
        this._schedule = [];
      }
    } catch (err) {
      console.warn('[Scheduler] Could not load schedule:', err);
      this._schedule = [];
    }
  }

  private _saveSchedule(): void {
    try {
      const dir = path.dirname(SCHEDULE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(this._schedule, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Scheduler] Could not save schedule:', err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _setState(patch: Partial<SchedulerState>): void {
    this._state = { ...this._state, ...patch };
  }

  // ── Session refresh monitor (24/7) ──────────────────────────────────────────
  // Checks every 60s while live — if the session goes idle (all plan blocks done),
  // generate a new night plan and restart so music never stops.
  private _startSessionRefreshMonitor(entry: ScheduleEntry): void {
    if (this._sessionRefreshTimer) clearInterval(this._sessionRefreshTimer);
    this._sessionRefreshTimer = setInterval(() => {
      if (this._state.status !== 'live') return;
      const session = sessionManager.snapshot();
      if (session.status === 'idle') {
        const currentHour = new Date().getHours();
        const nightPlan = sessionManager.generateNightPlan(entry.durationMins, currentHour);
        if (nightPlan.length > 0) {
          sessionManager.setPlan(nightPlan);
          sessionManager.start(nightPlan[0].genre, nightPlan[0].durationMins, nightPlan[1]?.genre ?? null, nightPlan, 0);
          const planStr = nightPlan.map(p => p.genre + '(' + p.durationMins + 'm)').join(' -> ');
          console.log('[Scheduler] Session exhausted — auto-restarting night plan: ' + planStr);
        }
      }
    }, 60_000);
  }

    private _setError(msg: string): void {
    this._setState({ status: 'error', lastError: msg });
    console.error(`[Scheduler] Error: ${msg}`);
  }
}

export const broadcastScheduler = new BroadcastScheduler();
