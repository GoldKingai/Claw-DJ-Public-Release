/**
 * Broadcast Scheduler — test scaffold
 *
 * Full integration tests require OBS and YouTube connectivity.
 * This scaffold covers the schedule logic, state management,
 * and pre-stream checklist with mocked dependencies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../services/obs-controller.js', () => ({
  obsController: {
    isConnected:    true,
    startStreaming: vi.fn().mockResolvedValue(undefined),
    stopStreaming:  vi.fn().mockResolvedValue(undefined),
    connect:        vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/youtube-stream-detector.js', () => ({
  youtubeStreamDetector: {
    status: { isLive: false },
  },
}));

vi.mock('../services/session-manager.js', () => ({
  sessionManager: {
    snapshot:          vi.fn(() => ({ status: 'idle', genre: '' })),
    start:             vi.fn(),
    end:               vi.fn(),
    setPlan:           vi.fn(),
    generateNightPlan: vi.fn(() => []),
    getStats:          vi.fn(() => ({ total: 10, byGenre: {}, thin: [] })),
  },
}));

vi.mock('../services/dj-local-engine.js', () => ({
  djLocalEngine: {
    refreshWorkerState: vi.fn().mockResolvedValue({ workerConnected: true, mode: 'idle', currentTrackId: null }),
  },
}));

vi.mock('../services/watchdog.js', () => ({
  scheduleXAnnouncement: vi.fn(),
  fireStreamStart:       vi.fn(),
}));

vi.mock('../services/x-poster.js', () => ({
  flowPost: vi.fn().mockResolvedValue(''),
}));

vi.mock('../services/discord-notifier.js', () => ({
  notify:        vi.fn().mockResolvedValue(undefined),
  notifyWarn:    vi.fn().mockResolvedValue(undefined),
  notifyError:   vi.fn().mockResolvedValue(undefined),
  notifySuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => {
  const mock = {
    existsSync:    vi.fn(() => false),
    readFileSync:  vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
    mkdirSync:     vi.fn(),
  };
  return { default: mock, ...mock };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BroadcastScheduler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('schedule CRUD', () => {
    it('addEntry assigns a unique id and persists', async () => {
      const { broadcastScheduler } = await import('../services/broadcast-scheduler.js');
      broadcastScheduler['_schedule'] = [];

      const entry = broadcastScheduler.addEntry({
        title:       'Test Stream',
        days:        [5],
        startHH:     21,
        startMM:     0,
        durationMins: 120,
        enabled:     true,
      });

      expect(entry.id).toMatch(/^sched_/);
      expect(broadcastScheduler.getSchedule().length).toBe(1);
    });

    it('deleteEntry removes the entry by id', async () => {
      const { broadcastScheduler } = await import('../services/broadcast-scheduler.js');
      broadcastScheduler['_schedule'] = [];

      const entry = broadcastScheduler.addEntry({
        title: 'To Delete', days: [1], startHH: 10, startMM: 0, durationMins: 60, enabled: true,
      });

      const deleted = broadcastScheduler.deleteEntry(entry.id);
      expect(deleted).toBe(true);
      expect(broadcastScheduler.getSchedule().length).toBe(0);
    });

    it('updateEntry patches fields without changing id', async () => {
      const { broadcastScheduler } = await import('../services/broadcast-scheduler.js');
      broadcastScheduler['_schedule'] = [];

      const entry = broadcastScheduler.addEntry({
        title: 'Original', days: [2], startHH: 8, startMM: 0, durationMins: 60, enabled: true,
      });

      const updated = broadcastScheduler.updateEntry(entry.id, { title: 'Updated', durationMins: 90 });
      expect(updated?.title).toBe('Updated');
      expect(updated?.durationMins).toBe(90);
      expect(updated?.id).toBe(entry.id);
    });
  });

  describe('state', () => {
    it('initial state is idle with no active entry', async () => {
      const { broadcastScheduler } = await import('../services/broadcast-scheduler.js');
      expect(broadcastScheduler.state.status).toBe('idle');
      expect(broadcastScheduler.state.activeEntry).toBeNull();
    });
  });

  // NOTE: Full _runStream() tests require OBS + YouTube integration.
  // When adding integration tests, override obsController.isConnected = true
  // and mock youtubeStreamDetector.status.isLive to simulate the live confirmation.
});
