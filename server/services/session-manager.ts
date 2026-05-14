/**
 * Session Manager
 *
 * Tracks the current DJ genre session — what's playing, how long, what's next.
 * The watchdog reads this to make autonomous decisions (fill queue, trigger transitions).
 * Ayla reads this to understand context. Neither the audio path nor TTS is touched here.
 *
 * Session model: one genre per session block.
 * Each block is planned from fresh track inventory for that genre, capped at 60 min.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackStore } from '../utils/music-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE     = path.join(__dirname, '../data/session-history.json');
const NIGHT_STATE_FILE = path.join(__dirname, '../data/night-state.json');

const MAX_BLOCK_MINS           = 60;
const MIN_TRACK_DURATION_SECS  = 60;
const FALLBACK_TRACK_DURATION_SECS = 210;
const NIGHT_STATE_MAX_AGE_MS   = 12 * 60 * 60 * 1000; // 12 hours
const TRACK_COOLDOWN_MS        = 90 * 60 * 1000;       // 90-minute soft cooldown

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionPlan {
  genre: string;
  durationMins: number;
  trackIds?: string[];
  trackCount?: number;
}

export interface SessionState {
  status: 'idle' | 'active';
  genre: string;
  startedAt: number;          // ms epoch
  plannedDurationMins: number;
  nextGenre: string | null;
  nightPlan: SessionPlan[];
  sessionIndex: number;       // which session tonight (0, 1, 2...)
  tracksPlayedIds: string[];  // prevents repeats within session
  nightPlayedByGenre: Record<string, string[]>;
  currentBlockTrackIds: string[];
  lastTrackPlayedAt: number;
  crossfadeStyle: number;     // seconds, genre-appropriate
  availableTracksTier: number; // 1=block, 2=night-fresh, 3=session-fallback, 0=exhausted
}

export interface SessionHistoryEntry {
  genre: string;
  startedAt: number;
  endedAt: number;
  durationMins: number;
  tracksPlayed: number;
  trackIds: string[];
}

interface PlannedTrack {
  id: string;
  genre: string;
  durationSecs: number;
  lastPlayedAt: number;
}

interface NightState {
  nightId: string;
  nightPlan: SessionPlan[];
  nightPlayedByGenre: Record<string, string[]>;
  trackLastPlayedAt: Record<string, number>;
  savedAt: number;
}

// Genre energy ladder — used for night plan ordering (chill first, peak last)
const GENRE_ENERGY_ORDER: Record<string, number> = {
  'lo-fi':          1,
  'reggae':         2,
  'afrobeats':      3,
  'afro-dancehall': 4,
  'amapiano':       5,
  'hip-hop':        6,
  'trap-dancehall': 7,
  'grime':          8,
  'drill':          9,
};

// Genre-appropriate crossfade durations (seconds)
const GENRE_CROSSFADE: Record<string, number> = {
  'lo-fi':          22,
  'reggae':         18,
  'afrobeats':      14,
  'afro-dancehall': 12,
  'amapiano':       12,
  'hip-hop':         8,
  'trap-dancehall':  5,
  'grime':           3,
  'drill':           3,
};


// Human-readable / TTS-friendly display names for genres
export const GENRE_DISPLAY_NAME: Record<string, string> = {
  'lo-fi':          'Lo-Fi',
  'reggae':         'Jamaican Reggae',
  'afrobeats':      'Afrobeats',
  'afro-dancehall': 'Afro Dancehall',
  'amapiano':       'Amapiano',
  'hip-hop':        'Hip-Hop',
  'trap-dancehall': 'Trap Dancehall',
  'grime':          'Grime',
  'drill':          'Drill',
};

// ── Service ───────────────────────────────────────────────────────────────────

class SessionManagerService {
  private state: SessionState = {
    status: 'idle',
    genre: '',
    startedAt: 0,
    plannedDurationMins: 60,
    nextGenre: null,
    nightPlan: [],
    sessionIndex: 0,
    tracksPlayedIds: [],
    nightPlayedByGenre: {},
    currentBlockTrackIds: [],
    lastTrackPlayedAt: 0,
    crossfadeStyle: 6,
    availableTracksTier: 0,
  };

  private history: SessionHistoryEntry[] = [];
  private _trackLastPlayedAt = new Map<string, number>();
  private _nightId = '';
  private _currentTier = 0;
  private _pendingNightState: NightState | null = null;

  constructor() {
    this._loadHistory();
    // Pre-load night state — applied on next start() if still fresh
    this._pendingNightState = this._loadNightState();
    if (this._pendingNightState) {
      console.log(`[Session] Loaded night state from disk (nightId: ${this._pendingNightState.nightId}, savedAt: ${new Date(this._pendingNightState.savedAt).toISOString()})`);
    }
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  start(
    genre: string,
    durationMins = 60,
    nextGenre?: string | null,
    nightPlan?: SessionPlan[],
    sessionIndexOverride?: number,
  ): SessionState {
    const previousState = this.snapshot();
    const hadActiveSession = previousState.status === 'active';

    if (hadActiveSession) {
      this._archiveCurrentSession();
    }

    const plan = this._normalisePlan(nightPlan ?? previousState.nightPlan);
    const sessionIndex = sessionIndexOverride ?? (hadActiveSession ? previousState.sessionIndex + 1 : 0);
    const block = plan[sessionIndex];

    // ── Night state restore (service-restart recovery) ────────────────────────
    let restoredNight: NightState | null = null;
    if (!hadActiveSession && this._pendingNightState) {
      restoredNight = this._pendingNightState;
      this._pendingNightState = null;
      this._nightId = restoredNight.nightId;
      this._trackLastPlayedAt = new Map(Object.entries(restoredNight.trackLastPlayedAt));
      console.log(`[Session] Restored night state: nightId=${this._nightId}, genres tracked=${Object.keys(restoredNight.nightPlayedByGenre).join(',')}`);
    } else if (!hadActiveSession) {
      // Fresh night — generate new nightId
      this._nightId = Date.now().toString();
      this._trackLastPlayedAt.clear();
      this._currentTier = 0;
    }

    this.state = {
      status: 'active',
      genre,
      startedAt: Date.now(),
      plannedDurationMins: durationMins,
      nextGenre: nextGenre ?? plan[sessionIndex + 1]?.genre ?? null,
      nightPlan: restoredNight ? this._normalisePlan(restoredNight.nightPlan.length > 0 ? restoredNight.nightPlan : plan) : plan,
      sessionIndex,
      tracksPlayedIds: [],
      nightPlayedByGenre: hadActiveSession
        ? { ...previousState.nightPlayedByGenre }
        : (restoredNight ? { ...restoredNight.nightPlayedByGenre } : {}),
      currentBlockTrackIds: block?.genre === genre ? [...(block.trackIds ?? [])] : [],
      lastTrackPlayedAt: 0,
      crossfadeStyle: GENRE_CROSSFADE[genre] ?? 6,
      availableTracksTier: 0,
    };

    this._saveNightState();
    console.log(`[Session] Started: genre=${genre}, duration=${durationMins}min, next=${this.state.nextGenre ?? 'none'}, nightId=${this._nightId}`);
    return this.snapshot();
  }

  end(): SessionState {
    if (this.state.status === 'active') {
      this._archiveCurrentSession();
    }
    // Clear night state — stream is fully done for the night
    this._nightId = '';
    this._trackLastPlayedAt.clear();
    this._currentTier = 0;
    this._clearNightState();

    this.state = {
      status: 'idle',
      genre: '',
      startedAt: 0,
      plannedDurationMins: 60,
      nextGenre: null,
      nightPlan: [],
      sessionIndex: 0,
      tracksPlayedIds: [],
      nightPlayedByGenre: {},
      currentBlockTrackIds: [],
      lastTrackPlayedAt: 0,
      crossfadeStyle: 6,
      availableTracksTier: 0,
    };
    console.log('[Session] Ended — night state cleared');
    return this.snapshot();
  }

  resetCurrentSessionTracks(): SessionState {
    this.state.tracksPlayedIds = [];
    this.state.lastTrackPlayedAt = 0;
    return this.snapshot();
  }

  trackPlayed(trackId: string): SessionState {
    if (!this.state.tracksPlayedIds.includes(trackId)) {
      this.state.tracksPlayedIds.push(trackId);
    }

    const genre = this.state.genre.toLowerCase().trim();
    if (genre) {
      const played = this.state.nightPlayedByGenre[genre] ?? [];
      if (!played.includes(trackId)) {
        this.state.nightPlayedByGenre[genre] = [...played, trackId];
      }
    }

    this.state.lastTrackPlayedAt = Date.now();
    this._trackLastPlayedAt.set(trackId, Date.now());
    this._saveNightState();
    return this.snapshot();
  }

  setPlan(nightPlan: SessionPlan[]): SessionState {
    this.state.nightPlan = this._normalisePlan(nightPlan);

    if (this.state.status !== 'active') {
      this.state.sessionIndex = 0;
      this.state.nextGenre = this.state.nightPlan[1]?.genre ?? null;
      this.state.currentBlockTrackIds = [...(this.state.nightPlan[0]?.trackIds ?? [])];
      this.state.nightPlayedByGenre = {};
      this._saveNightState();
      return this.snapshot();
    }

    this.state.nextGenre = this.state.nightPlan[this.state.sessionIndex + 1]?.genre ?? null;
    this.state.currentBlockTrackIds = [...(this.state.nightPlan[this.state.sessionIndex]?.trackIds ?? [])];
    this._saveNightState();
    return this.snapshot();
  }

  // ── Night plan auto-generator ───────────────────────────────────────────────

  generateNightPlan(streamDurationMins: number, currentHour: number): SessionPlan[] {
    const store = TrackStore.getInstance();
    const lastPlayedByTrack = this._buildTrackLastPlayedMap();
    const tracksByGenre = new Map<string, PlannedTrack[]>();

    const allValidTracks = store.getAll().filter(t => t.valid !== false);

    for (const track of allValidTracks) {
      const genre = track.genre?.toLowerCase().trim();
      if (!genre || genre === 'unknown') continue;

      const bucket = tracksByGenre.get(genre) ?? [];
      bucket.push({
        id: track.id,
        genre,
        durationSecs: this._trackDurationSecs(track.duration),
        lastPlayedAt: lastPlayedByTrack.get(track.id) ?? 0,
      });
      tracksByGenre.set(genre, bucket);
    }

    const viableGenres = Array.from(tracksByGenre.entries())
      .filter(([, tracks]) => tracks.length >= 3)
      .map(([genre]) => genre)
      .sort((a, b) => (GENRE_ENERGY_ORDER[a] ?? 5) - (GENRE_ENERGY_ORDER[b] ?? 5));

    if (viableGenres.length === 0) {
      // FALLBACK: untagged library (typical for downloaded mp3s with no ID3
      // genre tag — common in local party DJ use). Play everything in a single
      // mixed block sorted by least-recently-played. Better than refusing to
      // play music just because metadata is missing.
      if (allValidTracks.length > 0) {
        const sorted = [...allValidTracks].sort((a, b) => {
          const la = lastPlayedByTrack.get(a.id) ?? 0;
          const lb = lastPlayedByTrack.get(b.id) ?? 0;
          return la - lb || a.id.localeCompare(b.id);
        });
        const plan: SessionPlan = {
          genre: 'mixed',
          durationMins: Math.max(60, Math.floor(streamDurationMins)),
          trackIds: sorted.map(t => t.id),
          trackCount: sorted.length,
        };
        console.log(`[Session] Night plan (untagged fallback): mixed (${sorted.length} tracks)`);
        return [plan];
      }
      console.warn('[Session] generateNightPlan: no tracks available');
      return [];
    }

    let ordered = viableGenres;
    if (currentHour >= 22 || currentHour < 4) {
      ordered = ordered.filter(g => g !== 'lo-fi');
      if (viableGenres.includes('lo-fi')) {
        ordered = [...ordered, 'lo-fi'];
      }
    }

    const sortedTracksByGenre = new Map(ordered.map(genre => {
      const tracks = [...(tracksByGenre.get(genre) ?? [])]
        .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.id.localeCompare(b.id));
      return [genre, tracks];
    }));

    const cursors = new Map<string, number>();
    const plan: SessionPlan[] = [];
    let remainingMins = Math.max(0, Math.floor(streamDurationMins));
    let madeProgress = true;

    while (remainingMins > 0 && madeProgress) {
      madeProgress = false;

      for (const genre of ordered) {
        if (remainingMins <= 0) break;

        const tracks = sortedTracksByGenre.get(genre) ?? [];
        const startIndex = cursors.get(genre) ?? 0;
        if (startIndex >= tracks.length) continue;

        const block = this._takeGenreBlock(tracks, startIndex, Math.min(MAX_BLOCK_MINS, remainingMins));
        if (!block) continue;

        plan.push(block);
        cursors.set(genre, startIndex + (block.trackIds?.length ?? 0));
        remainingMins = Math.max(0, remainingMins - block.durationMins);
        madeProgress = true;
      }
    }

    console.log(`[Session] Night plan generated: ${plan.map(p => `${p.genre}(${p.durationMins}m)`).join(' → ')}`);
    return plan;
  }

  // ── Computed properties ─────────────────────────────────────────────────────

  get elapsedMins(): number {
    if (this.state.status !== 'active' || !this.state.startedAt) return 0;
    return (Date.now() - this.state.startedAt) / 60_000;
  }

  get remainingMins(): number {
    return Math.max(0, this.state.plannedDurationMins - this.elapsedMins);
  }

  /**
   * 3-tier track selection for the active session genre.
   * Tier 1: block-reserved fresh tracks not yet played this session
   * Tier 2: night-fresh tracks (not played tonight in this genre)
   * Tier 3: session fallback (not played this session, may have played earlier tonight)
   * Each tier applies a 90-min cooldown sort (oldest-played first).
   */
  getAvailableTracks(): Array<{ id: string; title: string; artist: string; genre: string; energy: number | null; bpm: number | null }> {
    if (this.state.status !== 'active') return [];

    const store = TrackStore.getInstance();
    const genre = this.state.genre.toLowerCase().trim();
    const playedThisSession = new Set(this.state.tracksPlayedIds);
    const currentBlockIds   = new Set(this.state.currentBlockTrackIds);
    const playedTonight     = new Set(this.state.nightPlayedByGenre[genre] ?? []);
    const now = Date.now();

    type Track = { id: string; title: string; artist: string; genre: string; energy: number | null; bpm: number | null };

    /** Sort with 90-min soft cooldown: cooled tracks first, then by oldest-played */
    const cooldownSort = (tracks: Track[]): Track[] =>
      [...tracks].sort((a, b) => {
        const aLast = this._trackLastPlayedAt.get(a.id) ?? 0;
        const bLast = this._trackLastPlayedAt.get(b.id) ?? 0;
        const aCooled = now - aLast > TRACK_COOLDOWN_MS;
        const bCooled = now - bLast > TRACK_COOLDOWN_MS;
        if (aCooled && !bCooled) return -1;
        if (!aCooled && bCooled) return 1;
        return aLast - bLast; // both same status: oldest first
      });

    // Special case: 'mixed' is the untagged-library fallback genre. It includes
    // ALL valid tracks regardless of their genre tag (typical for downloaded
    // mp3s with no metadata — local party DJ mode).
    const allGenreTracks: Track[] = store.getAll()
      .filter(t => {
        if (t.valid === false) return false;
        if (genre === 'mixed') return true;
        return t.genre?.toLowerCase().trim() === genre;
      })
      .map(t => ({ id: t.id, title: t.title, artist: t.artist, genre: t.genre, energy: t.energy ?? null, bpm: t.bpm ?? null }));

    // ── Tier 1: block-reserved tracks ────────────────────────────────────────
    if (currentBlockIds.size > 0) {
      const tier1 = allGenreTracks.filter(t => currentBlockIds.has(t.id) && !playedThisSession.has(t.id));
      if (tier1.length > 0) {
        if (this._currentTier !== 1) {
          console.log(`[Session] Tier 1 active — ${tier1.length} block-reserved tracks for genre=${genre}`);
          this._currentTier = 1;
          this.state.availableTracksTier = 1;
        }
        return cooldownSort(tier1);
      }
    }

    // ── Tier 2: night-fresh tracks ────────────────────────────────────────────
    const tier2 = allGenreTracks.filter(t => !playedThisSession.has(t.id) && !playedTonight.has(t.id));
    if (tier2.length > 0) {
      if (this._currentTier !== 2) {
        console.log(`[Session] Tier 2 active — ${tier2.length} night-fresh tracks for genre=${genre}`);
        this._currentTier = 2;
        this.state.availableTracksTier = 2;
      }
      return cooldownSort(tier2);
    }

    // ── Tier 3: session fallback ──────────────────────────────────────────────
    const tier3 = allGenreTracks.filter(t => !playedThisSession.has(t.id));
    if (tier3.length > 0) {
      if (this._currentTier !== 3) {
        console.warn(`[Session] Tier 3 fallback — all ${allGenreTracks.length} ${genre} tracks played tonight, recycling ${tier3.length} unplayed-this-session`);
        this._currentTier = 3;
        this.state.availableTracksTier = 3;
      }
      return cooldownSort(tier3);
    }

    // ── Exhausted ─────────────────────────────────────────────────────────────
    if (this._currentTier !== 0) {
      console.warn(`[Session] All tiers exhausted for genre="${genre}" (${allGenreTracks.length} total tracks) — returning empty`);
      this._currentTier = 0;
      this.state.availableTracksTier = 0;
    }
    return [];
  }

  /**
   * Rebalance remaining night plan blocks after a session overruns (>20%) or ends early.
   * Redistributes leftover or reclaimed time proportionally across remaining blocks.
   * Called by watchdog on session transition.
   */
  rebalancePlan(): SessionPlan[] {
    if (this.state.status !== 'active') return this.state.nightPlan;

    const currentIdx   = this.state.sessionIndex;
    const planned      = this.state.plannedDurationMins;
    const elapsed      = this.elapsedMins;
    const overrunPct   = planned > 0 ? (elapsed - planned) / planned : 0;

    // Only rebalance if overrun > 20% or ended more than 20% early
    if (Math.abs(overrunPct) < 0.20) return this.state.nightPlan;

    const remainingBlocks = this.state.nightPlan.slice(currentIdx + 1);
    if (remainingBlocks.length === 0) return this.state.nightPlan;

    // Time delta: positive = overran (borrow from remaining), negative = ended early (distribute surplus)
    const deltaMinutes = -(elapsed - planned); // negative overrun = less remaining time available
    const totalRemaining = remainingBlocks.reduce((s, b) => s + b.durationMins, 0);
    if (totalRemaining <= 0) return this.state.nightPlan;

    // Distribute delta proportionally across remaining blocks
    const rebalanced = remainingBlocks.map(block => {
      const proportion = block.durationMins / totalRemaining;
      const adjustment = Math.round(deltaMinutes * proportion);
      return { ...block, durationMins: Math.max(5, block.durationMins + adjustment) };
    });

    const newPlan = [
      ...this.state.nightPlan.slice(0, currentIdx + 1),
      ...rebalanced,
    ];

    this.state.nightPlan = this._normalisePlan(newPlan);
    this._saveNightState();

    console.log(
      '[Session] Plan rebalanced: overrun=' + overrunPct.toFixed(2) +
      ' remaining=' + rebalanced.map(b => b.genre + '(' + b.durationMins + 'm)').join(' -> ')
    );
    return this.state.nightPlan;
  }

  snapshot(): SessionState {
    const s = JSON.parse(JSON.stringify(this.state)) as SessionState;
    s.availableTracksTier = this._currentTier;
    return s;
  }

  getHistory(): SessionHistoryEntry[] {
    return [...this.history];
  }

  getStats(): { total: number; byGenre: Record<string, number>; thin: string[] } {
    const store = TrackStore.getInstance();
    const all = store.getAll();
    const byGenre: Record<string, number> = {};

    for (const track of all) {
      const genre = track.genre?.toLowerCase().trim() || 'unknown';
      byGenre[genre] = (byGenre[genre] ?? 0) + 1;
    }

    const thin = Object.entries(byGenre)
      .filter(([, count]) => count < 5)
      .map(([genre]) => genre);

    return { total: all.length, byGenre, thin };
  }

  // ── History persistence ─────────────────────────────────────────────────────

  private _archiveCurrentSession(): void {
    if (!this.state.startedAt) return;

    const entry: SessionHistoryEntry = {
      genre: this.state.genre,
      startedAt: this.state.startedAt,
      endedAt: Date.now(),
      durationMins: Math.round(this.elapsedMins),
      tracksPlayed: this.state.tracksPlayedIds.length,
      trackIds: [...this.state.tracksPlayedIds],
    };

    this.history.push(entry);
    if (this.history.length > 200) this.history = this.history.slice(-200);
    this._saveHistory();
  }

  private _loadHistory(): void {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
        this.history = JSON.parse(raw) as SessionHistoryEntry[];
      }
    } catch {
      this.history = [];
    }
  }

  private _saveHistory(): void {
    try {
      const dir = path.dirname(HISTORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Session] Could not save history:', err);
    }
  }

  // ── Night state persistence ─────────────────────────────────────────────────

  private _saveNightState(): void {
    if (!this._nightId) return;
    const state: NightState = {
      nightId:            this._nightId,
      nightPlan:          this.state.nightPlan,
      nightPlayedByGenre: this.state.nightPlayedByGenre,
      trackLastPlayedAt:  Object.fromEntries(this._trackLastPlayedAt),
      savedAt:            Date.now(),
    };
    try {
      const dir = path.dirname(NIGHT_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(NIGHT_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Session] Could not save night state:', err);
    }
  }

  private _loadNightState(): NightState | null {
    try {
      if (!fs.existsSync(NIGHT_STATE_FILE)) return null;
      const raw = fs.readFileSync(NIGHT_STATE_FILE, 'utf-8');
      const state = JSON.parse(raw) as NightState;
      if (!state.nightId || !state.savedAt) return null;
      if (Date.now() - state.savedAt > NIGHT_STATE_MAX_AGE_MS) {
        console.log('[Session] Night state expired (>12h), discarding');
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }

  private _clearNightState(): void {
    try {
      if (fs.existsSync(NIGHT_STATE_FILE)) fs.unlinkSync(NIGHT_STATE_FILE);
    } catch {
      // ignore
    }
  }

  // ── Plan helpers ────────────────────────────────────────────────────────────

  private _normalisePlan(nightPlan: SessionPlan[]): SessionPlan[] {
    return nightPlan.map(block => ({
      genre:      block.genre,
      durationMins: block.durationMins,
      trackIds:   [...(block.trackIds ?? [])],
      trackCount: block.trackCount ?? block.trackIds?.length,
    }));
  }

  private _buildTrackLastPlayedMap(): Map<string, number> {
    const lastPlayed = new Map<string, number>();

    for (const entry of this.history) {
      for (const trackId of entry.trackIds) {
        lastPlayed.set(trackId, Math.max(lastPlayed.get(trackId) ?? 0, entry.endedAt));
      }
    }

    return lastPlayed;
  }

  private _takeGenreBlock(tracks: PlannedTrack[], startIndex: number, maxDurationMins: number): SessionPlan | null {
    if (startIndex >= tracks.length || maxDurationMins <= 0) return null;

    const maxDurationSecs = Math.max(MIN_TRACK_DURATION_SECS, Math.floor(maxDurationMins * 60));
    const picked: PlannedTrack[] = [];
    let totalSecs = 0;

    for (let i = startIndex; i < tracks.length; i++) {
      const track = tracks[i];
      const nextTotal = totalSecs + track.durationSecs;
      if (picked.length > 0 && nextTotal > maxDurationSecs) break;
      picked.push(track);
      totalSecs = nextTotal;
      if (totalSecs >= maxDurationSecs) break;
    }

    if (picked.length === 0) return null;

    return {
      genre:       picked[0].genre,
      durationMins: Math.max(1, Math.ceil(totalSecs / 60)),
      trackIds:    picked.map(track => track.id),
      trackCount:  picked.length,
    };
  }


  /**
   * Calculate how many minutes of playable tracks exist for a genre right now,
   * capped at MAX_BLOCK_MINS (60 min). Uses live TrackStore so it reflects
   * any tracks that arrived after the night plan was generated.
   */
  calcSessionDurationMins(genre: string): number {
    const store = TrackStore.getInstance();
    const lowerGenre = genre.toLowerCase().trim();
    const tracks = store.getAll()
      .filter(t => t.valid !== false && t.genre?.toLowerCase().trim() === lowerGenre);

    let totalSecs = 0;
    const maxSecs = MAX_BLOCK_MINS * 60;
    for (const t of tracks) {
      totalSecs += this._trackDurationSecs(t.duration);
      if (totalSecs >= maxSecs) return MAX_BLOCK_MINS;
    }
    return Math.max(1, Math.ceil(totalSecs / 60));
  }

  private _trackDurationSecs(duration: number | null | undefined): number {
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      return Math.max(MIN_TRACK_DURATION_SECS, Math.round(duration));
    }
    return FALLBACK_TRACK_DURATION_SECS;
  }
}

export const sessionManager = new SessionManagerService();
