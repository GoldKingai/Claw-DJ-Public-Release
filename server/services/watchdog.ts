/**
 * Watchdog Service
 *
 * Always-on background loop (10s interval) running inside the claw-dj server.
 * Handles all routine operations autonomously and invokes Ayla only when
 * intelligence or personality is needed.
 *
 * Responsibilities:
 *  - Keep queue fed from session genre (no dead air)
 *  - Track session clock → 10-min warning, transition trigger
 *  - Detect and recover from engine errors
 *  - Route YouTube chat messages through Ayla (voice + chat post)
 *  - Track announcements every 3rd track
 *  - Milestone reactions (viewer counts)
 *  - Stream-start welcome sequence
 *
 * DO NOT TOUCH: mpv audio device, TTS port/config, duck ramp values.
 * The watchdog only calls existing /api/playback/commands and /api/tts/speak.
 */

import { sessionManager } from './session-manager.js';
import { askAyla } from './ayla-agent.js';
import { aylaPost } from './x-poster.js';
import { djLocalEngine } from './dj-local-engine.js';
import { youtubeMetricsService } from './youtube-metrics.js';
import { TrackStore } from '../utils/music-scanner.js';
import { modeManager } from './mode-manager.js';

const TICK_MS = 10_000;           // Main loop interval
const MIN_AYLA_INTERVAL_MS = 60_000; // Min gap between Ayla invocations (except errors)
const MAX_CHAT_MESSAGE_LEN = 200;

// ── Internal state ────────────────────────────────────────────────────────────

let _tickTimer: ReturnType<typeof setInterval> | null = null;
let _lastAylaAt = 0;
let _sessionWarningFired = false;
let _sessionTransitionFired = false;
let _streamStartFired = false;
let _trackAnnounceCount = 0;         // total tracks played since watchdog started
let _lastAnnouncedTrackId: string | null = null;
let _lastQueueFillAt = 0;
let _lastRecoveryAt = 0;
let _milestonesFired = new Set<number>(); // viewer thresholds already fired this session
let _crossfadeSyncedAt = 0;              // session.startedAt for which crossfade was last set
let _lastPlayedBpm: number | null = null;  // BPM of most recently started track (for BPM-aware picks)
let _consecutivePeakCount = 0;             // # consecutive tracks at energy ≥8 (for valley rule)
let _valleyTracksRemaining = 0;            // # valley tracks still required before returning to arc

// Chat outbound function — gets set by the server after youtube-chat service is wired
let _sendChatFn: ((text: string) => Promise<boolean>) | null = null;

// ── API call helpers (internal HTTP to avoid circular imports) ─────────────────

async function _playbackCommand(type: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3001/api/playback/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function _speak(text: string): Promise<void> {
  // Local mode: skip TTS entirely. Music plays, no banter.
  if (modeManager.isLocal()) return;
  try {
    await fetch('http://localhost:3001/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // TTS failure is non-fatal
  }
}

async function _sendChat(text: string): Promise<void> {
  if (!_sendChatFn) return;
  const truncated = text.length > MAX_CHAT_MESSAGE_LEN
    ? text.slice(0, MAX_CHAT_MESSAGE_LEN - 3) + '...'
    : text;
  await _sendChatFn(truncated).catch(() => {});
}

// ── DJ intelligence — energy arc, BPM compatibility, track selection ──────────

/** Effective energy: use track.energy field, or derive from BPM when null. */
function _effectiveEnergy(energy: number | null, bpm: number | null): number {
  if (energy !== null && energy > 0) return energy;
  const b = bpm ?? 90;
  if (b <= 80)  return 3;
  if (b <= 100) return 5;
  if (b <= 130) return 7;
  return 9;
}

/**
 * Target energy level for the current arc position (0.0–1.0 = elapsed/planned).
 * Models a standard set arc: ease in → build → peak → resolve → outro.
 */
function _arcTargetEnergy(arcPos: number): number {
  if (arcPos < 0.15) return 4;   // Opening: ease in (3–5)
  if (arcPos < 0.40) return 6;   // Build (5–7)
  if (arcPos < 0.70) return 8;   // Peak (7–9)
  if (arcPos < 0.85) return 6;   // Resolution (5–7)
  return 3;                       // Outro: wind down (3–4)
}

interface TrackCandidate {
  id: string;
  title: string;
  artist: string;
  genre: string;
  energy: number | null;
  bpm: number | null;
}

/** Score a candidate track. Higher = better fit for current arc position and BPM flow. */
function _scoreTrack(track: TrackCandidate, targetEnergy: number, lastBpm: number | null): number {
  const e = _effectiveEnergy(track.energy, track.bpm);
  let score = 10 - Math.abs(e - targetEnergy) * 2;  // Energy match: up to 10pts

  // BPM compatibility with current track
  if (lastBpm && track.bpm) {
    const pct = Math.abs(track.bpm - lastBpm) / Math.max(track.bpm, lastBpm);
    if (pct <= 0.02) score += 3;       // ≤2%: seamless blend
    else if (pct <= 0.06) score += 1;  // 3–6%: quick cut ok
    else score -= 2;                   // >6%: hard transition, avoid
  }

  return score;
}

/** Pick best next track using energy arc + BPM compatibility. Random among top 3 to avoid predictability. */
function _pickNextTrack(
  available: TrackCandidate[],
  targetEnergy: number,
  lastBpm: number | null,
): TrackCandidate | null {
  if (available.length === 0) return null;
  const scored = available
    .map(t => ({ track: t, score: _scoreTrack(t, targetEnergy, lastBpm) }))
    .sort((a, b) => b.score - a.score);
  const topN = Math.min(3, scored.length);
  return scored[Math.floor(Math.random() * topN)].track;
}

/**
 * Crossfade duration adjusted for BPM compatibility.
 * Large BPM differences reduce blend time to avoid rhythmic mud,
 * but the minimum respects the genre character (lo-fi minimum ≠ grime minimum).
 */
function _bpmCrossfadeSecs(currentBpm: number | null, nextBpm: number | null, genreDefault: number): number {
  if (!currentBpm || !nextBpm) return genreDefault;
  const pct = Math.abs(currentBpm - nextBpm) / Math.max(currentBpm, nextBpm);
  if (pct <= 0.02) return genreDefault;                              // ≤2% — perfect blend, full duration
  if (pct <= 0.06) return Math.max(Math.round(genreDefault * 0.6), 3); // 3–6% — tighten to 60% of default
  return Math.max(Math.round(genreDefault * 0.3), 3);               // >6% — quick cut, but ≥ 3s minimum
  // Note: for chill genres (lo-fi default=22s), >6% BPM diff → max(7, 3) = 7s (still smooth)
  // For grime (default=3s), >6% BPM diff → max(1, 3) = 3s (already a hard cut)
}

// ── Ayla invocation with anti-spam guard ─────────────────────────────────────

type AylaContext = 'chat' | 'announce' | 'session' | 'error' | 'startup' | 'milestone';

async function _invokeAyla(message: string, context: AylaContext, dualChannel = true): Promise<string> {
  // Local mode: skip all LLM/TTS/chat invocations. The watchdog still manages
  // queue, crossfades, and session rotation — just no AI banter.
  if (modeManager.isLocal()) {
    return '';
  }

  const now = Date.now();

  // Error + startup contexts bypass the rate limit
  if (context !== 'error' && context !== 'startup' && now - _lastAylaAt < MIN_AYLA_INTERVAL_MS) {
    console.log(`[Watchdog] Ayla rate-limited (context: ${context})`);
    return '';
  }

  _lastAylaAt = now;
  console.log(`[Watchdog] Invoking Ayla — context: ${context}`);

  const response = await askAyla('watchdog', message);
  if (!response) return '';

  if (dualChannel) {
    await Promise.all([
      _speak(response),
      _sendChat(response),
    ]);
  }

  return response;
}

// ── Queue management ──────────────────────────────────────────────────────────

async function _checkQueue(): Promise<void> {
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  const engineState = await djLocalEngine.refreshWorkerState();
  const now = Date.now();

  // If engine is idle while session is active, fill and play immediately
  if (engineState.mode === 'idle') {
    const available = sessionManager.getAvailableTracks();
    if (available.length === 0) {
      // All tracks played — reset play history and loop the genre
      console.log('[Watchdog] All tracks played in session — resetting play history');
      sessionManager.start(session.genre, session.plannedDurationMins, session.nextGenre, session.nightPlan);
      return;
    }

    // Calculate arc position and target energy
    const arcPos = session.plannedDurationMins > 0
      ? Math.min(1, sessionManager.elapsedMins / session.plannedDurationMins)
      : 0;
    // After 3 consecutive ≥8 energy peaks, force 2 valley tracks (energy reset)
    if (_consecutivePeakCount >= 3 && _valleyTracksRemaining === 0) {
      _valleyTracksRemaining = 2;
      console.log('[Watchdog] Valley rule triggered — forcing 2 lower-energy tracks');
    }
    const valleyForced = _valleyTracksRemaining > 0;
    const targetEnergy = valleyForced ? 5 : _arcTargetEnergy(arcPos);

    const pick = _pickNextTrack(available, targetEnergy, _lastPlayedBpm);
    if (!pick) return;

    console.log(`[Watchdog] Engine idle — auto-playing: "${pick.title}" energy=${_effectiveEnergy(pick.energy, pick.bpm).toFixed(1)} bpm=${pick.bpm ?? '?'} (arc=${arcPos.toFixed(2)} target=${targetEnergy}${valleyForced ? ' VALLEY' : ''})`);

    // Sync crossfade to genre once per session
    if (session.startedAt !== _crossfadeSyncedAt) {
      _crossfadeSyncedAt = session.startedAt;
      await _playbackCommand('set-crossfade', { durationSeconds: session.crossfadeStyle });
    }

    await _playbackCommand('play-track-now', { trackId: pick.id });
    sessionManager.trackPlayed(pick.id);
    return;
  }

  // If queue is thin (< 2), fill it — throttle to 5s to refill quickly after crossfade
  // (30s throttle caused silence: queue drops to 1 after crossfade, 30s guard blocked refill,
  //  so the single remaining track hit its 30s preload window with an empty queue → no crossfade → EOS → silence)
  if (engineState.queue.length < 2 && now - _lastQueueFillAt > 5_000) {
    _lastQueueFillAt = now;
    const available = sessionManager.getAvailableTracks()
      .filter(t => !engineState.queue.some(q => q.trackId === t.id))
      .filter(t => t.id !== engineState.currentTrackId); // never queue the currently-playing track

    if (available.length === 0) {
      // About to run out — reset play history
      const state = sessionManager.snapshot();
      if (state.tracksPlayedIds.length > 0) {
        sessionManager.start(session.genre, session.plannedDurationMins, session.nextGenre, session.nightPlan);
      }
      return;
    }

    // Calculate arc position and target energy
    const arcPos = session.plannedDurationMins > 0
      ? Math.min(1, sessionManager.elapsedMins / session.plannedDurationMins)
      : 0;
    if (_consecutivePeakCount >= 3 && _valleyTracksRemaining === 0) {
      _valleyTracksRemaining = 2;
      console.log('[Watchdog] Valley rule triggered — forcing 2 lower-energy tracks');
    }
    const valleyForced = _valleyTracksRemaining > 0;
    const targetEnergy = valleyForced ? 5 : _arcTargetEnergy(arcPos);

    // Fill up to 2 tracks, each scored for energy arc + BPM fit
    const slotsNeeded = 2 - engineState.queue.length;
    let pickedBpm = _lastPlayedBpm;
    // Track IDs we've already committed to this fill pass (queue snapshot won't include them)
    const pickedIds = new Set<string>(engineState.queue.map(q => q.trackId));

    for (let i = 0; i < slotsNeeded; i++) {
      const remaining = available.filter(t => !pickedIds.has(t.id));
      const pick = _pickNextTrack(remaining, targetEnergy, pickedBpm);
      if (!pick) break;

      // Adjust crossfade duration for BPM compatibility with current playing track
      const cfSecs = _bpmCrossfadeSecs(pickedBpm, pick.bpm, session.crossfadeStyle);
      if (cfSecs !== session.crossfadeStyle && i === 0) {
        // Only update crossfade for the immediately-next track (position 0 in queue)
        await _playbackCommand('set-crossfade', { durationSeconds: cfSecs });
        console.log(`[Watchdog] Crossfade adjusted: ${cfSecs}s (bpm ${pickedBpm ?? '?'} → ${pick.bpm ?? '?'})`);
      }

      pickedIds.add(pick.id);
      await _playbackCommand('enqueue', { trackId: pick.id });
      sessionManager.trackPlayed(pick.id);
      pickedBpm = pick.bpm ?? pickedBpm;
      console.log(`[Watchdog] Enqueued: "${pick.title}" energy=${_effectiveEnergy(pick.energy, pick.bpm).toFixed(1)} bpm=${pick.bpm ?? '?'} (target=${targetEnergy.toFixed(1)})`);
    }
  }
}

// ── Session clock ─────────────────────────────────────────────────────────────

async function _checkSessionClock(): Promise<void> {
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  const elapsed = sessionManager.elapsedMins;
  const planned = session.plannedDurationMins;

  // 10-minute warning
  if (!_sessionWarningFired && elapsed >= planned - 10) {
    _sessionWarningFired = true;
    const nextInfo = session.nextGenre ? `next up is ${session.nextGenre}` : 'no next session set';
    await _invokeAyla(
      `watchdog: 10 mins left in the ${session.genre} session. ${nextInfo}. give the crowd a heads up naturally.`,
      'session',
    );
  }

  // Session over — transition
  if (!_sessionTransitionFired && elapsed >= planned) {
    _sessionTransitionFired = true;
    if (session.nextGenre) {
      await _invokeAyla(
        `watchdog: ${session.genre} session is done. transition to ${session.nextGenre} now. ` +
        `fade out, announce the switch, then the watchdog will start the new session.`,
        'session',
      );
      // Give Ayla 5s to speak, then flip session
      setTimeout(async () => {
        // Look up duration + next-after-next from the night plan so it's preserved
        const planEntry     = session.nightPlan[session.sessionIndex + 1]; // the session we're starting
        const nextPlanEntry = session.nightPlan[session.sessionIndex + 2]; // the one after that
        const nextDuration  = planEntry?.durationMins ?? 60;
        const nextNext      = nextPlanEntry?.genre ?? null;
        sessionManager.start(session.nextGenre!, nextDuration, nextNext, session.nightPlan);
        resetSessionFlags(); // resets all per-session flags including BPM/peak state
        // Set crossfade immediately for new genre (resetSessionFlags clears _crossfadeSyncedAt,
        // so the watchdog would also sync on next tick, but do it now to avoid 10s gap)
        const newSession = sessionManager.snapshot();
        await _playbackCommand('set-crossfade', { durationSeconds: newSession.crossfadeStyle });
        // stop current playback cleanly
        await _playbackCommand('fade-to', { volume: 0, rampSecs: 3 });
        setTimeout(() => _playbackCommand('stop'), 3500);
      }, 5_000);
    } else {
      // No next genre — ask Ayla what to do
      await _invokeAyla(
        `watchdog: ${session.genre} session has exceeded planned time. continue or wrap up? ` +
        `tracksPlayed=${session.tracksPlayedIds.length}`,
        'session',
      );
    }
  }
}

// ── Track announcements ───────────────────────────────────────────────────────

async function _checkTrackAnnouncement(): Promise<void> {
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  const engineState = await djLocalEngine.refreshWorkerState();
  if (!engineState.currentTrackId || engineState.currentTrackId === _lastAnnouncedTrackId) return;

  _lastAnnouncedTrackId = engineState.currentTrackId;
  _trackAnnounceCount++;

  // Update BPM tracking + valley rule state for the new track
  const fullTrack = TrackStore.getInstance().getById(engineState.currentTrackId);
  if (fullTrack) {
    _lastPlayedBpm = fullTrack.bpm;
    const e = _effectiveEnergy(fullTrack.energy, fullTrack.bpm);
    if (e >= 8) {
      _consecutivePeakCount++;
      console.log(`[Watchdog] Peak track (energy ${e.toFixed(1)}) — consecutive peaks: ${_consecutivePeakCount}`);
    } else {
      _consecutivePeakCount = 0;
      // Count down the valley obligation
      if (_valleyTracksRemaining > 0) {
        _valleyTracksRemaining--;
        console.log(`[Watchdog] Valley track played — ${_valleyTracksRemaining} valley track(s) remaining`);
      }
    }
  }

  // Post track to YouTube chat every track
  await _sendChat(`🎵 ${engineState.currentTrackTitle ?? 'Unknown'} — ${engineState.currentTrackArtist ?? ''}`);

  // Announce via voice every 3rd track
  if (_trackAnnounceCount % 3 === 0) {
    await _invokeAyla(
      `watchdog: new track started — "${engineState.currentTrackTitle}" by ${engineState.currentTrackArtist}. ` +
      `genre: ${session.genre}. announce naturally. keep it short and in character.`,
      'announce',
      false, // voice only — chat already got the track info above
    ).then(response => {
      if (response) _speak(response);
    });
  }
}

// ── Engine health ─────────────────────────────────────────────────────────────

async function _checkEngineHealth(): Promise<void> {
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  const engineState = await djLocalEngine.refreshWorkerState();
  const now = Date.now();

  if (engineState.mode === 'error' && now - _lastRecoveryAt > 30_000) {
    _lastRecoveryAt = now;
    console.warn(`[Watchdog] Engine error detected: ${engineState.lastError} — attempting recovery`);

    // Attempt recovery: try skip first
    const recovered = await _playbackCommand('skip');
    if (!recovered) {
      // Escalate to Ayla
      await _invokeAyla(
        `watchdog: engine error — ${engineState.lastError}. mpv connected: ${engineState.workerConnected}. ` +
        `diagnose and recover. current genre: ${session.genre}.`,
        'error',
      );
    }
  }

  // mpv-disconnected escalation only makes sense when mpv is the intended
  // audio source (Ayla's stream mode). On Windows / local mode the
  // browser-deck is the audio path and mpv is expected to be absent.
  if (!engineState.workerConnected && modeManager.isLive() && now - _lastRecoveryAt > 30_000) {
    _lastRecoveryAt = now;
    console.warn('[Watchdog] mpv disconnected — escalating to Ayla');
    await _invokeAyla(
      `watchdog: mpv audio engine is not connected. stream may be silent. ` +
      `genre: ${session.genre}. tracksPlayed: ${session.tracksPlayedIds.length}.`,
      'error',
    );
  }
}

// ── Milestone tracking ────────────────────────────────────────────────────────

async function _checkMilestones(): Promise<void> {
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  const VIEWER_MILESTONES = [50, 100, 500, 1000];

  try {
    const metrics = youtubeMetricsService.snapshot;
    if (!metrics || metrics.updatedAt === 0) return;

    const viewers = metrics.viewers ?? 0;
    for (const threshold of VIEWER_MILESTONES) {
      if (viewers >= threshold && !_milestonesFired.has(threshold)) {
        _milestonesFired.add(threshold);
        await _invokeAyla(
          `watchdog: milestone — ${viewers} concurrent viewers. react appropriately. ` +
          `keep it in character. genre: ${session.genre}.`,
          'milestone',
        );
        break; // only one milestone per tick
      }
    }
  } catch {
    // metrics may not be available
  }
}

// ── Stream-start welcome ──────────────────────────────────────────────────────

async function _checkStreamStart(): Promise<void> {
  if (_streamStartFired) return;
  const session = sessionManager.snapshot();
  if (session.status !== 'active') return;

  // Mark as fired to avoid repeating
  _streamStartFired = true;

  const planStr = session.nightPlan.length > 0
    ? session.nightPlan.map(p => `${p.genre} (${p.durationMins}min)`).join(' → ')
    : `${session.genre} session`;

  await _invokeAyla(
    `watchdog: stream just went live. tonight's plan: ${planStr}. ` +
    `introduce yourself and the first session. keep it natural and in character.`,
    'startup',
  );
}

// ── Chat handler (registered as youtube-chat response handler) ─────────────────

async function _handleChatMessage(user: string, text: string): Promise<string> {
  const session = sessionManager.snapshot();
  const engineState = await djLocalEngine.refreshWorkerState();

  const response = await _invokeAyla(
    `watchdog: viewer "${user}" says: "${text}". ` +
    `current session: ${session.genre || 'no active session'}. ` +
    `now playing: ${engineState.currentTrackTitle ?? 'nothing'} by ${engineState.currentTrackArtist ?? 'unknown'}. ` +
    `respond in character. duck + speak then unduck happens automatically.`,
    'chat',
    false, // Don't auto-speak from invokeAyla — return the text for the chat service to broadcast
  );

  // Post to YouTube chat separately (voice goes through the chat service's TTS trigger)
  if (response) {
    await _sendChat(response);
    await _speak(response);
  }

  return response;
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function _tick(): Promise<void> {
  try {
    await _checkStreamStart();
    await _checkQueue();
    await _checkSessionClock();
    await _checkTrackAnnouncement();
    await _checkEngineHealth();
  } catch (err) {
    console.error('[Watchdog] Tick error:', err);
  }
}

// Milestone check runs less frequently (every 60s)
let _milestoneTickCount = 0;
async function _tickWithMilestones(): Promise<void> {
  await _tick();
  _milestoneTickCount++;
  if (_milestoneTickCount % 6 === 0) { // every ~60s
    await _checkMilestones().catch(() => {});
    await _checkXAnnouncements().catch(() => {});
  }
}

// ── X (Twitter) pre-live announcements ───────────────────────────────────────

let _xScheduledStreamTime: number | null = null;
let _x60MinFired = false;
let _x10MinFired = false;

async function _checkXAnnouncements(): Promise<void> {
  // Local mode: skip all social posts.
  if (modeManager.isLocal()) return;
  if (!_xScheduledStreamTime) return;
  const minsUntil = (_xScheduledStreamTime - Date.now()) / 60000;

  if (!_x60MinFired && minsUntil <= 61 && minsUntil > 9) {
    _x60MinFired = true;
    console.log('[Watchdog] Firing X 60-min pre-live announcement');
    await aylaPost(
      'x-scheduler: post a tweet announcing you are going live in about 1 hour on YouTube. ' +
      'Be yourself — short, cool, in character as Ayla. Include the channel link https://youtube.com/@Claw DJ. ' +
      'Max 280 chars. No hashtag spam, max 2-3 relevant tags.'
    ).catch(() => {});
  }

  if (!_x10MinFired && minsUntil <= 11 && minsUntil > 0) {
    _x10MinFired = true;
    console.log('[Watchdog] Firing X 10-min pre-live announcement');
    await aylaPost(
      'x-scheduler: post a tweet announcing you are going live in 10 minutes on YouTube. ' +
      'Urgency, hype, in character as Ayla. Include the channel link https://youtube.com/@Claw DJ. ' +
      'Max 280 chars.'
    ).catch(() => {});
  }

  // Clear after stream time passes
  if (minsUntil < -5) {
    _xScheduledStreamTime = null;
    _x60MinFired = false;
    _x10MinFired = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the watchdog loop. Call once from server startup. */
export function startWatchdog(): void {
  if (_tickTimer) return;
  _tickTimer = setInterval(() => {
    _tickWithMilestones().catch(() => {});
  }, TICK_MS);
  if (_tickTimer?.unref) _tickTimer.unref();
  console.log('[Watchdog] Started — 10s tick');
}

/** Stop the watchdog loop. */
export function stopWatchdog(): void {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
  console.log('[Watchdog] Stopped');
}

/** Register the function that posts messages to YouTube live chat. */
export function setWatchdogChatSender(fn: (text: string) => Promise<boolean>): void {
  _sendChatFn = fn;
}

/**
 * Get the chat response handler to register with youtubeChatService.
 * This replaces the direct askAyla handler — routes through dual-channel (TTS + chat post).
 */
export function getWatchdogChatHandler(): (user: string, text: string) => Promise<string> {
  return _handleChatMessage;
}

/**
 * Get a Discord message handler. Calls askAyla directly (same as the original system),
 * with lightweight DJ state appended so Ayla knows what's playing.
 * No rate limiting, no TTS, no YouTube chat cross-posting.
 */
export function getWatchdogDiscordHandler(): (user: string, text: string) => Promise<string> {
  return async (user: string, text: string): Promise<string> => {
    const session = sessionManager.snapshot();
    const engineState = await djLocalEngine.refreshWorkerState();

    const trackInfo = engineState.currentTrackTitle
      ? `currently playing: ${engineState.currentTrackTitle} by ${engineState.currentTrackArtist ?? 'unknown'}`
      : 'nothing playing right now';
    const sessionInfo = session.genre ? `session: ${session.genre}` : 'no active session';

    return askAyla(user, `${text} [${trackInfo}, ${sessionInfo}]`);
  };
}

/** Fire the stream-start welcome sequence (idempotent). */
export function fireStreamStart(): void {
  _streamStartFired = false; // reset so it fires on next tick
}

/** Schedule a future X pre-live announcement. Pass a Unix timestamp (ms) for stream start time. */
export function scheduleXAnnouncement(streamStartMs: number): void {
  _xScheduledStreamTime = streamStartMs;
  _x60MinFired = false;
  _x10MinFired = false;
  console.log('[Watchdog] X announcements scheduled for', new Date(streamStartMs).toISOString());
}

/** Post a spontaneous Ayla tweet now (presence/engagement). No-op in local mode. */
export async function postAylaTweet(prompt: string): Promise<void> {
  if (modeManager.isLocal()) return;
  await aylaPost(prompt).catch(() => {});
}

/** Return internal watchdog state for debug/dashboard endpoints. */
export function getWatchdogDebugState(): {
  lastAylaChatAt: number;
  lastAylaAnnounceAt: number;
  chatCooldownActiveMs: number;
  announceCooldownActiveMs: number;
  streamStartFired: boolean;
  sessionWarningFired: boolean;
  sessionTransitionFired: boolean;
  trackAnnounceCount: number;
} {
  const now = Date.now();
  const cooldown = Math.max(0, MIN_AYLA_INTERVAL_MS - (now - _lastAylaAt));
  return {
    lastAylaChatAt: _lastAylaAt,
    lastAylaAnnounceAt: _lastAylaAt,
    chatCooldownActiveMs: cooldown,
    announceCooldownActiveMs: cooldown,
    streamStartFired: _streamStartFired,
    sessionWarningFired: _sessionWarningFired,
    sessionTransitionFired: _sessionTransitionFired,
    trackAnnounceCount: _trackAnnounceCount,
  };
}

/** Reset per-session flags (call when a new session starts). */
export function resetSessionFlags(): void {
  _sessionWarningFired = false;
  _sessionTransitionFired = false;
  _milestonesFired.clear();
  _crossfadeSyncedAt = 0;
  _lastPlayedBpm = null;
  _consecutivePeakCount = 0;
  _valleyTracksRemaining = 0;
}
