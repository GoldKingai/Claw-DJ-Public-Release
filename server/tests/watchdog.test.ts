/**
 * Watchdog — test scaffold
 *
 * Full watchdog tests require mocking the engine, session, and Flow agent.
 * This scaffold covers the stateless helpers and the X post guards.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../services/session-manager.js', () => ({
  sessionManager: {
    snapshot:    vi.fn(() => ({ status: 'idle', genre: '', tracksPlayedIds: [], nightPlan: [], sessionIndex: 0 })),
    trackPlayed: vi.fn(),
    resetCurrentSessionTracks: vi.fn(),
    getAvailableTracks: vi.fn(() => []),
    elapsedMins: 0,
  },
}));

vi.mock('../services/flow-agent.js', () => ({
  askFlow: vi.fn().mockResolvedValue(''),
}));

vi.mock('../services/x-poster.js', () => ({
  flowPost: vi.fn().mockResolvedValue(''),
}));

vi.mock('../services/dj-local-engine.js', () => ({
  djLocalEngine: {
    refreshWorkerState: vi.fn().mockResolvedValue({ mode: 'idle', queue: [], currentTrackId: null, workerConnected: true }),
  },
}));

vi.mock('../services/youtube-metrics.js', () => ({
  youtubeMetricsService: {
    snapshot: null,
  },
}));

vi.mock('../utils/music-scanner.js', () => ({
  TrackStore: {
    getInstance: () => ({
      getAll:    () => [],
      getById:   () => null,
    }),
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Watchdog', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('getWatchdogDebugState()', () => {
    it('returns zero cooldowns when no invocations have occurred', async () => {
      const { getWatchdogDebugState } = await import('../services/watchdog.js');
      const debug = getWatchdogDebugState();

      expect(debug.lastFlowChatAt).toBe(0);
      expect(debug.lastFlowAnnounceAt).toBe(0);
      expect(debug.chatCooldownActiveMs).toBe(0);
      expect(debug.announceCooldownActiveMs).toBe(0);
    });
  });

  describe('scheduleXAnnouncement()', () => {
    it('can be called without throwing', async () => {
      const { scheduleXAnnouncement } = await import('../services/watchdog.js');
      expect(() => scheduleXAnnouncement(Date.now() + 60_000)).not.toThrow();
    });
  });

  describe('fireStreamStart()', () => {
    it('can be called without throwing', async () => {
      const { fireStreamStart } = await import('../services/watchdog.js');
      expect(() => fireStreamStart()).not.toThrow();
    });
  });

  describe('resetSessionFlags()', () => {
    it('resets all per-session flags without throwing', async () => {
      const { resetSessionFlags, getWatchdogDebugState } = await import('../services/watchdog.js');
      expect(() => resetSessionFlags()).not.toThrow();
      const debug = getWatchdogDebugState();
      expect(debug.sessionWarningFired).toBe(false);
      expect(debug.sessionTransitionFired).toBe(false);
      expect(debug.trackAnnounceCount).toBe(0);
    });
  });

  // NOTE: _tick(), _checkQueue(), _checkSessionClock() etc. require
  // integration-style testing with proper timer control (vi.useFakeTimers).
  // These are marked for Phase 4.x implementation.
});
