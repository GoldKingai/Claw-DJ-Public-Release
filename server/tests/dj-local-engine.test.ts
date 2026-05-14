/**
 * Tests for DjLocalEngineService — queue authority, EOS auto-advance,
 * worker reconciliation, and error recovery.
 *
 * The worker client is mocked so no GStreamer or TCP socket is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock worker client ────────────────────────────────────────────────────────

const mockWorkerResponses: Record<string, () => Promise<any>> = {};

vi.mock('../services/dj-local-worker-client.js', () => ({
  djLocalWorkerClient: {
    status: () => mockWorkerResponses['status']?.() ?? Promise.resolve(makeWorkerResp('idle', 0)),
    play: (_uri: string) => mockWorkerResponses['play']?.() ?? Promise.resolve(makeWorkerResp('playing', 0)),
    pause: () => mockWorkerResponses['pause']?.() ?? Promise.resolve(makeWorkerResp('paused', 0)),
    resume: () => mockWorkerResponses['resume']?.() ?? Promise.resolve(makeWorkerResp('playing', 0)),
    stop: () => mockWorkerResponses['stop']?.() ?? Promise.resolve(makeWorkerResp('idle', 0)),
    seek: (_pos: number) => mockWorkerResponses['seek']?.() ?? Promise.resolve(makeWorkerResp('playing', 0)),
    setVolume: (_vol: number) => mockWorkerResponses['volume']?.() ?? Promise.resolve(makeWorkerResp('playing', 0)),
  },
}));

// ── Mock TrackStore ───────────────────────────────────────────────────────────

const MOCK_TRACKS: Record<string, { id: string; title: string; artist: string; duration: number; filePath: string }> = {
  'track-1': { id: 'track-1', title: 'Track One', artist: 'Artist A', duration: 180, filePath: '/music/track1.mp3' },
  'track-2': { id: 'track-2', title: 'Track Two', artist: 'Artist B', duration: 210, filePath: '/music/track2.mp3' },
  'track-3': { id: 'track-3', title: 'Track Three', artist: 'Artist C', duration: 240, filePath: '/music/track3.mp3' },
};

vi.mock('../utils/music-scanner.js', () => ({
  TrackStore: {
    getInstance: () => ({
      getById: (id: string) => MOCK_TRACKS[id] ?? null,
    }),
  },
}));

// ── Mock fs (state file persistence) ─────────────────────────────────────────

vi.mock('fs', () => ({
  default: {
    existsSync: () => false,
    readFileSync: () => '{}',
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
  },
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: () => undefined,
  mkdirSync: () => undefined,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let eosCounter = 0;

function makeWorkerResp(mode: string, eosCount?: number) {
  return {
    ok: true,
    requestId: 'test',
    type: 'status',
    state: {
      protocolVersion: 1,
      workerId: 'dj-worker-1',
      mode,
      currentTrack: null,
      positionSeconds: 0,
      durationSeconds: 0,
      volume: 1,
      muted: false,
      buffering: false,
      eosCount: eosCount ?? eosCounter,
      currentPlaybackToken: null,
      lastError: '',
      updatedAt: Date.now(),
      lastCommandAt: 0,
    },
  };
}

function makeWorkerError(code: string, message: string) {
  return {
    ok: false,
    requestId: 'test',
    type: 'pause',
    error: { code, message },
    state: makeWorkerResp('idle').state,
  };
}

// ── Import engine (after mocks) ───────────────────────────────────────────────

// Use dynamic import so mocks are in place first
let djLocalEngine: Awaited<typeof import('../services/dj-local-engine.js')>['djLocalEngine'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DjLocalEngine — queue operations', () => {
  beforeEach(async () => {
    vi.resetModules();
    eosCounter = 0;
    // Re-import fresh instance
    const mod = await import('../services/dj-local-engine.js');
    djLocalEngine = mod.djLocalEngine;
    // Stop polling to prevent interference
    (djLocalEngine as any).pollTimer && clearInterval((djLocalEngine as any).pollTimer);
    (djLocalEngine as any).pollTimer = null;
  });

  it('enqueue adds a QueueItem with stable queueItemId', () => {
    const state = djLocalEngine.enqueue('track-1');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].trackId).toBe('track-1');
    expect(state.queue[0].queueItemId).toMatch(/^qi_/);
    expect(state.queueRevision).toBe(1);
  });

  it('enqueue returns error state for unknown track', () => {
    const state = djLocalEngine.enqueue('no-such-track');
    expect(state.queue).toHaveLength(0);
    expect(state.lastError).toBe('Track not found');
  });

  it('removeQueueById removes by stable id', () => {
    djLocalEngine.enqueue('track-1');
    djLocalEngine.enqueue('track-2');
    const id = djLocalEngine.snapshot().queue[0].queueItemId;
    const state = djLocalEngine.removeQueueById(id);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].trackId).toBe('track-2');
    expect(state.queueRevision).toBe(3);
  });

  it('removeQueueById is a no-op for unknown id', () => {
    djLocalEngine.enqueue('track-1');
    const state = djLocalEngine.removeQueueById('qi_nonexistent');
    expect(state.queue).toHaveLength(1);
  });

  it('removeQueueIndex removes by index', () => {
    djLocalEngine.enqueue('track-1');
    djLocalEngine.enqueue('track-2');
    const state = djLocalEngine.removeQueueIndex(0);
    expect(state.queue[0].trackId).toBe('track-2');
  });

  it('clearQueue empties the queue', () => {
    djLocalEngine.enqueue('track-1');
    djLocalEngine.enqueue('track-2');
    const state = djLocalEngine.clearQueue();
    expect(state.queue).toHaveLength(0);
    expect(state.nextQueueItemId).toBeNull();
  });

  it('moveQueueItem reorders correctly', () => {
    djLocalEngine.enqueue('track-1');
    djLocalEngine.enqueue('track-2');
    djLocalEngine.enqueue('track-3');
    const state = djLocalEngine.moveQueueItem(0, 2);
    expect(state.queue.map((q: any) => q.trackId)).toEqual(['track-2', 'track-3', 'track-1']);
  });

  it('nextQueueItemId points to first queue item', () => {
    djLocalEngine.enqueue('track-1');
    djLocalEngine.enqueue('track-2');
    const snap = djLocalEngine.snapshot();
    expect(snap.nextQueueItemId).toBe(snap.queue[0].queueItemId);
  });
});

describe('DjLocalEngine — playback commands', () => {
  beforeEach(async () => {
    vi.resetModules();
    eosCounter = 0;
    const mod = await import('../services/dj-local-engine.js');
    djLocalEngine = mod.djLocalEngine;
    (djLocalEngine as any).pollTimer && clearInterval((djLocalEngine as any).pollTimer);
    (djLocalEngine as any).pollTimer = null;
  });

  it('playNow sets mode to playing and sets currentTrackId', async () => {
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    const state = await djLocalEngine.playNow('track-1');
    expect(state.mode).toBe('playing');
    expect(state.currentTrackId).toBe('track-1');
    expect(state.currentTrackTitle).toBe('Track One');
    expect(state.workerConnected).toBe(true);
  });

  it('playNow returns error for unknown track', async () => {
    const state = await djLocalEngine.playNow('no-such-track');
    expect(state.mode).toBe('error');
    expect(state.lastError).toBe('Track not found');
  });

  it('playNow handles worker error gracefully', async () => {
    mockWorkerResponses['play'] = () => Promise.reject(new Error('worker connection refused'));
    const state = await djLocalEngine.playNow('track-1');
    expect(state.mode).toBe('error');
    expect(state.lastError).toContain('worker connection refused');
  });

  it('pause sets mode to paused on success', async () => {
    mockWorkerResponses['pause'] = () => Promise.resolve(makeWorkerResp('paused', 0));
    const state = await djLocalEngine.pause();
    expect(state.mode).toBe('paused');
  });

  it('pause error from worker keeps original mode', async () => {
    mockWorkerResponses['pause'] = () => Promise.resolve(makeWorkerError('INVALID_STATE', 'cannot pause from idle'));
    // engine starts idle
    const state = await djLocalEngine.pause();
    // mode stays idle (response.ok is false so we keep this.state.mode)
    expect(state.mode).toBe('idle');
    expect(state.lastError).toContain('cannot pause from idle');
  });

  it('resume sets mode to playing', async () => {
    mockWorkerResponses['resume'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    const state = await djLocalEngine.resume();
    expect(state.mode).toBe('playing');
  });

  it('stop sets mode to idle and clears current track', async () => {
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');
    mockWorkerResponses['stop'] = () => Promise.resolve(makeWorkerResp('idle', 0));
    const state = await djLocalEngine.stop();
    expect(state.mode).toBe('idle');
    expect(state.currentTrackId).toBeNull();
  });

  it('skip with empty queue calls stop', async () => {
    mockWorkerResponses['stop'] = () => Promise.resolve(makeWorkerResp('idle', 0));
    const state = await djLocalEngine.skip();
    expect(state.mode).toBe('idle');
  });

  it('skip with queued items advances to next track', async () => {
    djLocalEngine.enqueue('track-2');
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    const state = await djLocalEngine.skip();
    expect(state.mode).toBe('playing');
    expect(state.currentTrackId).toBe('track-2');
    expect(state.queue).toHaveLength(0);
  });
});

describe('DjLocalEngine — EOS auto-advance', () => {
  beforeEach(async () => {
    vi.resetModules();
    eosCounter = 0;
    const mod = await import('../services/dj-local-engine.js');
    djLocalEngine = mod.djLocalEngine;
    (djLocalEngine as any).pollTimer && clearInterval((djLocalEngine as any).pollTimer);
    (djLocalEngine as any).pollTimer = null;
  });

  it('EOS with queued next item advances queue', async () => {
    // Seed engine as playing
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');
    djLocalEngine.enqueue('track-2');

    // Poll with eosCount=1 (EOS fired)
    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('idle', 1));
    await djLocalEngine.refreshWorkerState();

    const state = djLocalEngine.snapshot();
    expect(state.currentTrackId).toBe('track-2');
    expect(state.mode).toBe('playing');
    expect(state.queue).toHaveLength(0);
  });

  it('EOS with empty queue sets mode to idle', async () => {
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');

    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('idle', 1));
    await djLocalEngine.refreshWorkerState();

    const state = djLocalEngine.snapshot();
    expect(state.mode).toBe('idle');
    expect(state.currentTrackId).toBeNull();
  });

  it('EOS does not fire twice for same eosCount', async () => {
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');
    djLocalEngine.enqueue('track-2');
    djLocalEngine.enqueue('track-3');

    // First EOS
    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('playing', 1));
    await djLocalEngine.refreshWorkerState();
    // Second poll same eosCount — should not advance again
    await djLocalEngine.refreshWorkerState();

    const state = djLocalEngine.snapshot();
    expect(state.currentTrackId).toBe('track-2');
    expect(state.queue).toHaveLength(1); // track-3 still queued
  });
});

describe('DjLocalEngine — worker restart reconciliation', () => {
  beforeEach(async () => {
    vi.resetModules();
    eosCounter = 0;
    const mod = await import('../services/dj-local-engine.js');
    djLocalEngine = mod.djLocalEngine;
    (djLocalEngine as any).pollTimer && clearInterval((djLocalEngine as any).pollTimer);
    (djLocalEngine as any).pollTimer = null;
  });

  it('detects worker restart via eosCount reset and reconciles playback-lost', async () => {
    // Start playing
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');
    // Poll a few times to establish eosCount baseline
    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('playing', 3));
    await djLocalEngine.refreshWorkerState();

    // Worker restarts: eosCount resets to 0
    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('idle', 0));
    (djLocalEngine as any).wasWorkerConnected = true; // was connected
    await djLocalEngine.refreshWorkerState();

    // Should detect playback lost, mode should not be "playing" anymore
    const state = djLocalEngine.snapshot();
    expect(state.mode).not.toBe('playing');
  });

  it('auto-recovers to next queued track after worker restart', async () => {
    mockWorkerResponses['play'] = () => Promise.resolve(makeWorkerResp('playing', 0));
    await djLocalEngine.playNow('track-1');
    djLocalEngine.enqueue('track-2');

    // Simulate worker restart
    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('playing', 5));
    await djLocalEngine.refreshWorkerState(); // eosCount baseline = 5

    mockWorkerResponses['status'] = () => Promise.resolve(makeWorkerResp('idle', 0));
    (djLocalEngine as any).wasWorkerConnected = true;
    await djLocalEngine.refreshWorkerState();

    const state = djLocalEngine.snapshot();
    expect(state.currentTrackId).toBe('track-2');
    expect(state.mode).toBe('playing');
  });

  it('worker disconnect sets workerConnected false', async () => {
    mockWorkerResponses['status'] = () => Promise.reject(new Error('connect ECONNREFUSED'));
    await djLocalEngine.refreshWorkerState();
    const state = djLocalEngine.snapshot();
    expect(state.workerConnected).toBe(false);
    expect(state.lastError).toContain('ECONNREFUSED');
  });
});
