import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock types ────────────────────────────────────────────────────────────────

type MockTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number | null;
  energy: number | null;
  valid: boolean;
};

// ── Shared mock state ─────────────────────────────────────────────────────────

let mockTracks: MockTrack[] = [];
let mockHistoryJson: string | null = null;
let mockNightStateJson: string | null = null;

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../utils/music-scanner.js', () => ({
  TrackStore: {
    getInstance: () => ({
      getAll: () => mockTracks,
    }),
  },
}));

vi.mock('node:fs', () => {
  const existsSync = (p: string) => {
    if ((p as string).endsWith('night-state.json')) return mockNightStateJson !== null;
    if ((p as string).endsWith('session-history.json')) return mockHistoryJson !== null;
    return false;
  };
  const readFileSync = (p: string) => {
    if ((p as string).endsWith('night-state.json') && mockNightStateJson !== null) return mockNightStateJson;
    if ((p as string).endsWith('session-history.json') && mockHistoryJson !== null) return mockHistoryJson;
    throw new Error('ENOENT: no such file or directory');
  };
  const mock = {
    existsSync,
    readFileSync,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { default: mock, ...mock };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrack(id: string, genre: string, duration = 180, opts: Partial<MockTrack> = {}): MockTrack {
  return {
    id,
    title: id,
    artist: `${genre}-artist`,
    album: `${genre}-album`,
    genre,
    duration,
    bpm: null,
    energy: null,
    valid: true,
    ...opts,
  };
}

function lofiTracks(n: number, durationSecs = 180): MockTrack[] {
  return Array.from({ length: n }, (_, i) => makeTrack(`lofi-${i + 1}`, 'lo-fi', durationSecs));
}

function hiphopTracks(n: number): MockTrack[] {
  return Array.from({ length: n }, (_, i) => makeTrack(`hiphop-${i + 1}`, 'hip-hop', 200));
}

function grimeTracks(n: number): MockTrack[] {
  return Array.from({ length: n }, (_, i) => makeTrack(`grime-${i + 1}`, 'grime', 200));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionManagerService', () => {
  beforeEach(() => {
    vi.resetModules();
    mockTracks = [];
    mockHistoryJson = null;
    mockNightStateJson = null;
  });

  // ── Session lifecycle ───────────────────────────────────────────────────────

  describe('start()', () => {
    it('sets status to active with correct genre and duration', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      const state = sessionManager.start('lo-fi', 45);

      expect(state.status).toBe('active');
      expect(state.genre).toBe('lo-fi');
      expect(state.plannedDurationMins).toBe(45);
      expect(state.tracksPlayedIds).toEqual([]);
    });

    it('sets nextGenre from plan when provided', async () => {
      mockTracks = [...lofiTracks(3), ...hiphopTracks(3)];
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 20, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
        { genre: 'hip-hop', durationMins: 20, trackIds: ['hiphop-1', 'hiphop-2', 'hiphop-3'] },
      ];

      const state = sessionManager.start('lo-fi', 20, 'hip-hop', plan, 0);

      expect(state.nextGenre).toBe('hip-hop');
      expect(state.sessionIndex).toBe(0);
    });

    it('preserves nightPlayedByGenre on genre transition (hadActiveSession)', async () => {
      mockTracks = [...lofiTracks(6), ...hiphopTracks(3)];
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 10);
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-2');

      // Transition to hip-hop
      sessionManager.start('hip-hop', 10);
      const state = sessionManager.snapshot();

      // nightPlayedByGenre should carry over 'lo-fi' plays
      expect(state.nightPlayedByGenre['lo-fi']).toContain('lofi-1');
      expect(state.nightPlayedByGenre['lo-fi']).toContain('lofi-2');
    });

    it('increments sessionIndex on successive transitions', async () => {
      mockTracks = [...lofiTracks(3), ...hiphopTracks(3), ...grimeTracks(3)];
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 10);
      expect(sessionManager.snapshot().sessionIndex).toBe(0);

      sessionManager.start('hip-hop', 10);
      expect(sessionManager.snapshot().sessionIndex).toBe(1);

      sessionManager.start('grime', 10);
      expect(sessionManager.snapshot().sessionIndex).toBe(2);
    });

    it('uses sessionIndexOverride when provided', async () => {
      mockTracks = [...lofiTracks(3), ...hiphopTracks(3), ...grimeTracks(3)];
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 10 },
        { genre: 'hip-hop', durationMins: 10 },
        { genre: 'grime', durationMins: 10 },
      ];

      sessionManager.start('grime', 10, null, plan, 2);

      expect(sessionManager.snapshot().sessionIndex).toBe(2);
    });

    it('sets currentBlockTrackIds from matching plan block', async () => {
      mockTracks = lofiTracks(6);
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 10, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
      ];

      sessionManager.start('lo-fi', 10, null, plan, 0);
      const state = sessionManager.snapshot();

      expect(state.currentBlockTrackIds).toEqual(['lofi-1', 'lofi-2', 'lofi-3']);
    });
  });

  describe('end()', () => {
    it('sets status to idle and resets state', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      sessionManager.trackPlayed('lofi-1');
      const ended = sessionManager.end();

      expect(ended.status).toBe('idle');
      expect(ended.genre).toBe('');
      expect(ended.tracksPlayedIds).toEqual([]);
      expect(ended.nightPlayedByGenre).toEqual({});
    });

    it('archives session to history before resetting', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      sessionManager.trackPlayed('lofi-1');
      sessionManager.end();

      const history = sessionManager.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].genre).toBe('lo-fi');
      expect(history[0].trackIds).toContain('lofi-1');
    });
  });

  describe('resetCurrentSessionTracks()', () => {
    it('clears tracksPlayedIds without touching nightPlayedByGenre', async () => {
      mockTracks = lofiTracks(6);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-2');
      sessionManager.resetCurrentSessionTracks();

      const state = sessionManager.snapshot();
      expect(state.tracksPlayedIds).toEqual([]);
      expect(state.nightPlayedByGenre['lo-fi']).toContain('lofi-1');
    });
  });

  // ── trackPlayed() ─────────────────────────────────────────────────────────

  describe('trackPlayed()', () => {
    it('adds trackId to tracksPlayedIds without duplicates', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-1'); // duplicate

      expect(sessionManager.snapshot().tracksPlayedIds).toEqual(['lofi-1']);
    });

    it('updates nightPlayedByGenre[genre]', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      sessionManager.trackPlayed('lofi-1');

      expect(sessionManager.snapshot().nightPlayedByGenre['lo-fi']).toContain('lofi-1');
    });

    it('sets lastTrackPlayedAt to current time', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      const before = Date.now();
      sessionManager.trackPlayed('lofi-1');
      const after = Date.now();

      const t = sessionManager.snapshot().lastTrackPlayedAt;
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    });
  });

  // ── getAvailableTracks() 3-tier ───────────────────────────────────────────

  describe('getAvailableTracks()', () => {
    it('Tier 1: returns only block-reserved tracks when currentBlockTrackIds set', async () => {
      mockTracks = lofiTracks(6);
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 10, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
      ];

      sessionManager.start('lo-fi', 10, null, plan, 0);
      const available = sessionManager.getAvailableTracks().map(t => t.id);

      // Only Tier 1 tracks (lofi-1..3), not lofi-4..6
      expect(available).toEqual(expect.arrayContaining(['lofi-1', 'lofi-2', 'lofi-3']));
      expect(available).not.toContain('lofi-4');
      expect(available.length).toBe(3);
    });

    it('Tier 1: excludes tracks already played this session', async () => {
      mockTracks = lofiTracks(6);
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 10, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
      ];

      sessionManager.start('lo-fi', 10, null, plan, 0);
      sessionManager.trackPlayed('lofi-1');
      const available = sessionManager.getAvailableTracks().map(t => t.id);

      expect(available).not.toContain('lofi-1');
      expect(available).toContain('lofi-2');
    });

    it('Tier 2: falls back to night-fresh tracks when block exhausted', async () => {
      mockTracks = lofiTracks(6);
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi', durationMins: 10, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
        { genre: 'lo-fi', durationMins: 10, trackIds: ['lofi-4', 'lofi-5', 'lofi-6'] },
      ];

      sessionManager.start('lo-fi', 10, null, plan, 0);
      // Play all Tier 1 tracks
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-2');
      sessionManager.trackPlayed('lofi-3');

      // Transition to second lo-fi block (sessionIndex=1, Tier 1 = lofi-4..6)
      sessionManager.start('lo-fi', 10, null, plan, 1);
      const available = sessionManager.getAvailableTracks().map(t => t.id);

      // Second block should have only lofi-4..6
      expect(available).toEqual(expect.arrayContaining(['lofi-4', 'lofi-5', 'lofi-6']));
      expect(available).not.toContain('lofi-1');
      expect(available.length).toBe(3);
    });

    it('Tier 3: falls back to session fallback when all night tracks exhausted', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      // Mark all tracks as played tonight
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-2');
      // lofi-3 played via nightPlayedByGenre trick — manually mark night plays
      const state = sessionManager.snapshot();
      // Simulate all 3 tracks being in nightPlayedByGenre (played during earlier session)
      // by playing them all in session and then resetting session (not night) plays
      sessionManager.trackPlayed('lofi-3');
      sessionManager.resetCurrentSessionTracks();

      // Now none are in tracksPlayedIds, but all are in nightPlayedByGenre
      // Tier 2 would be empty, should fall to Tier 3
      const available = sessionManager.getAvailableTracks();
      expect(available.length).toBe(3); // All available via Tier 3 recycling
    });

    it('returns empty array when session is idle', async () => {
      const { sessionManager } = await import('../services/session-manager.js');

      const available = sessionManager.getAvailableTracks();
      expect(available).toEqual([]);
    });

    it('excludes tracks with valid === false', async () => {
      mockTracks = [
        makeTrack('lofi-1', 'lo-fi'),
        makeTrack('lofi-2', 'lo-fi', 180, { valid: false }),
        makeTrack('lofi-3', 'lo-fi'),
      ];
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 30);
      const available = sessionManager.getAvailableTracks().map(t => t.id);

      expect(available).not.toContain('lofi-2');
      expect(available).toContain('lofi-1');
      expect(available).toContain('lofi-3');
    });
  });

  // ── generateNightPlan() ────────────────────────────────────────────────────

  describe('generateNightPlan()', () => {
    it('builds duration-aware blocks with a hard 60-minute cap and spaces repeat genres', async () => {
      mockTracks = [
        ...Array.from({ length: 20 }, (_, i) => makeTrack(`lofi-${i + 1}`, 'lo-fi', 4 * 60)),
        ...hiphopTracks(3).map((t, i) => ({ ...t, duration: 200 })),
        ...grimeTracks(3).map((t, i) => ({ ...t, duration: 200 })),
      ];

      const { sessionManager } = await import('../services/session-manager.js');
      const plan = sessionManager.generateNightPlan(200, 21);

      expect(plan.map(b => b.durationMins)).toEqual([60, 10, 10, 20]);
      expect(plan.every(b => b.durationMins <= 60)).toBe(true);
      expect(plan.map(b => b.genre)).toEqual(['lo-fi', 'hip-hop', 'grime', 'lo-fi']);

      const firstLoFi = plan[0]?.trackIds ?? [];
      const secondLoFi = plan[3]?.trackIds ?? [];
      expect(firstLoFi.length).toBe(15);
      expect(secondLoFi.length).toBe(5);
      expect(secondLoFi.some(id => firstLoFi.includes(id))).toBe(false);
    });

    it('uses reserved block tracks so a returning genre avoids replaying same songs', async () => {
      mockTracks = [
        ...Array.from({ length: 6 }, (_, i) => makeTrack(`lofi-${i + 1}`, 'lo-fi', 180)),
        ...Array.from({ length: 3 }, (_, i) => makeTrack(`hiphop-${i + 1}`, 'hip-hop', 180)),
      ];

      const { sessionManager } = await import('../services/session-manager.js');
      const nightPlan = [
        { genre: 'lo-fi',   durationMins: 9, trackIds: ['lofi-1', 'lofi-2', 'lofi-3'] },
        { genre: 'hip-hop', durationMins: 9, trackIds: ['hiphop-1', 'hiphop-2', 'hiphop-3'] },
        { genre: 'lo-fi',   durationMins: 9, trackIds: ['lofi-4', 'lofi-5', 'lofi-6'] },
      ];

      sessionManager.setPlan(nightPlan);
      sessionManager.start('lo-fi', 9, 'hip-hop', nightPlan, 0);
      sessionManager.trackPlayed('lofi-1');
      sessionManager.trackPlayed('lofi-2');
      sessionManager.trackPlayed('lofi-3');

      sessionManager.start('hip-hop', 9, 'lo-fi', nightPlan, 1);
      sessionManager.trackPlayed('hiphop-1');

      sessionManager.start('lo-fi', 9, null, nightPlan, 2);
      const available = sessionManager.getAvailableTracks().map(t => t.id);

      expect(available).toEqual(['lofi-4', 'lofi-5', 'lofi-6']);
    });

    it('moves lo-fi to end of plan for late-night hours (>= 22)', async () => {
      mockTracks = [
        ...lofiTracks(5, 180),
        ...hiphopTracks(5),
        ...grimeTracks(5),
      ];

      const { sessionManager } = await import('../services/session-manager.js');
      const plan = sessionManager.generateNightPlan(120, 23); // hour=23 → late night

      const genres = plan.map(b => b.genre);
      const lofiIdx = genres.lastIndexOf('lo-fi');
      const hiphopIdx = genres.indexOf('hip-hop');
      const grimeIdx = genres.indexOf('grime');

      // lo-fi should appear AFTER hip-hop and grime in late night
      expect(lofiIdx).toBeGreaterThan(Math.max(hiphopIdx, grimeIdx));
    });

    it('skips genres with fewer than 3 tracks', async () => {
      mockTracks = [
        ...lofiTracks(5),
        makeTrack('hiphop-1', 'hip-hop'), // only 1 hip-hop track → skip
        makeTrack('hiphop-2', 'hip-hop'),
        ...grimeTracks(4),
      ];

      const { sessionManager } = await import('../services/session-manager.js');
      const plan = sessionManager.generateNightPlan(60, 20);

      const genres = plan.map(b => b.genre);
      expect(genres).not.toContain('hip-hop');
      expect(genres).toContain('lo-fi');
      expect(genres).toContain('grime');
    });

    it('returns empty plan when no genres have 3+ tracks', async () => {
      mockTracks = [makeTrack('lofi-1', 'lo-fi'), makeTrack('lofi-2', 'lo-fi')];

      const { sessionManager } = await import('../services/session-manager.js');
      const plan = sessionManager.generateNightPlan(60, 20);

      expect(plan).toEqual([]);
    });
  });

  // ── setPlan() ──────────────────────────────────────────────────────────────

  describe('setPlan()', () => {
    it('updates nightPlan and sets nextGenre correctly when idle', async () => {
      const { sessionManager } = await import('../services/session-manager.js');
      const plan = [
        { genre: 'lo-fi',   durationMins: 30 },
        { genre: 'hip-hop', durationMins: 20 },
      ];

      sessionManager.setPlan(plan);
      const state = sessionManager.snapshot();

      expect(state.nightPlan.length).toBe(2);
      expect(state.nextGenre).toBe('hip-hop'); // plan[1]
    });

    it('updates nextGenre based on current sessionIndex when active', async () => {
      mockTracks = [...lofiTracks(3), ...hiphopTracks(3), ...grimeTracks(3)];
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 20);
      const plan = [
        { genre: 'lo-fi',   durationMins: 20 },
        { genre: 'hip-hop', durationMins: 20 },
        { genre: 'grime',   durationMins: 20 },
      ];
      sessionManager.setPlan(plan);
      const state = sessionManager.snapshot();

      // sessionIndex is 0, so nextGenre = plan[1] = hip-hop
      expect(state.nextGenre).toBe('hip-hop');
    });
  });

  // ── snapshot() + elapsedMins / remainingMins ───────────────────────────────

  describe('elapsedMins / remainingMins', () => {
    it('elapsedMins is 0 when idle', async () => {
      const { sessionManager } = await import('../services/session-manager.js');
      expect(sessionManager.elapsedMins).toBe(0);
    });

    it('remainingMins equals plannedDurationMins right after start', async () => {
      mockTracks = lofiTracks(3);
      const { sessionManager } = await import('../services/session-manager.js');

      sessionManager.start('lo-fi', 45);
      // Immediately after start, remainingMins ≈ plannedDurationMins
      expect(sessionManager.remainingMins).toBeCloseTo(45, 0);
    });
  });

  // ── getStats() ─────────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns correct total and per-genre counts', async () => {
      mockTracks = [
        ...lofiTracks(6),
        ...hiphopTracks(3),
        ...grimeTracks(4),
      ];

      const { sessionManager } = await import('../services/session-manager.js');
      const stats = sessionManager.getStats();

      expect(stats.total).toBe(13);
      expect(stats.byGenre['lo-fi']).toBe(6);
      expect(stats.byGenre['hip-hop']).toBe(3);
      expect(stats.byGenre['grime']).toBe(4);
    });

    it('marks genres with fewer than 5 tracks as thin', async () => {
      mockTracks = [...lofiTracks(6), ...hiphopTracks(3)];

      const { sessionManager } = await import('../services/session-manager.js');
      const stats = sessionManager.getStats();

      expect(stats.thin).toContain('hip-hop');
      expect(stats.thin).not.toContain('lo-fi');
    });
  });

  // ── Night state restoration ────────────────────────────────────────────────

  describe('night state persistence', () => {
    it('restores nightPlayedByGenre from disk on service restart', async () => {
      const nightState = {
        nightId: 'test-night-123',
        nightPlan: [{ genre: 'lo-fi', durationMins: 30, trackIds: ['lofi-1', 'lofi-2'] }],
        nightPlayedByGenre: { 'lo-fi': ['lofi-1', 'lofi-2'] },
        trackLastPlayedAt: { 'lofi-1': Date.now() - 5000, 'lofi-2': Date.now() - 3000 },
        savedAt: Date.now() - 30_000, // 30s ago — still fresh
      };
      mockNightStateJson = JSON.stringify(nightState);
      mockTracks = lofiTracks(6);

      const { sessionManager } = await import('../services/session-manager.js');
      sessionManager.start('lo-fi', 30);
      const state = sessionManager.snapshot();

      // Should have restored lo-fi night plays
      expect(state.nightPlayedByGenre['lo-fi']).toContain('lofi-1');
      expect(state.nightPlayedByGenre['lo-fi']).toContain('lofi-2');
    });

    it('ignores night state older than 12 hours', async () => {
      const nightState = {
        nightId: 'old-night',
        nightPlan: [],
        nightPlayedByGenre: { 'lo-fi': ['lofi-1', 'lofi-2'] },
        trackLastPlayedAt: {},
        savedAt: Date.now() - 13 * 60 * 60 * 1000, // 13 hours ago — expired
      };
      mockNightStateJson = JSON.stringify(nightState);
      mockTracks = lofiTracks(6);

      const { sessionManager } = await import('../services/session-manager.js');
      sessionManager.start('lo-fi', 30);
      const state = sessionManager.snapshot();

      // Should NOT restore expired night state
      expect(state.nightPlayedByGenre['lo-fi'] ?? []).toEqual([]);
    });
  });
});
