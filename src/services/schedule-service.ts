/**
 * Schedule Service — Builds genre-based time blocks from the music library.
 *
 * Scans all tracks, groups them by genre, then creates a rolling schedule
 * of themed sets (e.g., "Chill Ambient", "Hip Hop", "Electronic").
 * The AI DJ uses this to auto-schedule what genre to play next.
 */

import { libraryService, type TrackInfo } from '../library/library-service.js';

export interface ScheduleBlock {
  id: string;
  genre: string;
  label: string;
  startTime: Date;
  durationMinutes: number;
  trackCount: number;
  isActive: boolean;
}

export interface GenreGroup {
  genre: string;
  trackCount: number;
  totalDuration: number; // seconds
}

type ChangeCallback = () => void;

class ScheduleService {
  private _schedule: ScheduleBlock[] = [];
  private _genres: GenreGroup[] = [];
  private _listeners: Set<ChangeCallback> = new Set();
  private _refreshTimer: number | null = null;
  private _activeBlockId: string | null = null;

  // Config
  private _blockDuration = 60; // minutes per block

  get schedule(): ScheduleBlock[] { return [...this._schedule]; }
  get genres(): GenreGroup[] { return [...this._genres]; }
  get activeBlock(): ScheduleBlock | null {
    return this._schedule.find(b => b.id === this._activeBlockId) ?? null;
  }

  onChange(cb: ChangeCallback): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _notify(): void {
    this._listeners.forEach(cb => cb());
  }

  /**
   * Build or rebuild the schedule from the current library.
   * Call after library changes or on startup.
   */
  async buildSchedule(): Promise<void> {
    try {
      const tracks = await libraryService.getTracks();
      if (tracks.length === 0) {
        this._schedule = [];
        this._genres = [];
        this._notify();
        return;
      }

      // Group tracks by genre
      this._genres = this._groupByGenre(tracks);

      // Build time blocks starting from now
      this._schedule = this._buildBlocks(this._genres);

      // Mark the first block as active
      if (this._schedule.length > 0) {
        this._schedule[0].isActive = true;
        this._activeBlockId = this._schedule[0].id;
      }

      this._notify();
    } catch (err) {
      console.error('[schedule] Failed to build schedule:', err);
    }
  }

  /**
   * Advance to the next schedule block.
   * Returns the genre of the new active block, or null if schedule is empty.
   */
  advanceBlock(): string | null {
    if (this._schedule.length === 0) return null;

    const activeIdx = this._schedule.findIndex(b => b.id === this._activeBlockId);
    // Deactivate current
    if (activeIdx >= 0) {
      this._schedule[activeIdx].isActive = false;
    }

    // Move to next (wrap around)
    const nextIdx = (activeIdx + 1) % this._schedule.length;
    this._schedule[nextIdx].isActive = true;
    this._activeBlockId = this._schedule[nextIdx].id;

    // Update start times from now
    const now = new Date();
    for (let i = 0; i < this._schedule.length; i++) {
      const offset = i - nextIdx;
      const adjustedOffset = offset < 0 ? offset + this._schedule.length : offset;
      this._schedule[(nextIdx + adjustedOffset) % this._schedule.length].startTime =
        new Date(now.getTime() + adjustedOffset * this._blockDuration * 60000);
    }

    this._notify();
    return this._schedule[nextIdx].genre;
  }

  /** Get tracks for a specific genre (for the AI DJ to queue from) */
  async getTracksForGenre(genre: string): Promise<TrackInfo[]> {
    const tracks = await libraryService.getTracks();
    return tracks.filter(t =>
      t.genre.toLowerCase() === genre.toLowerCase()
    );
  }

  /** Set the duration of each schedule block (minutes) */
  setBlockDuration(minutes: number): void {
    this._blockDuration = Math.max(15, Math.min(180, minutes));
  }

  // ── Internal ──

  private _groupByGenre(tracks: TrackInfo[]): GenreGroup[] {
    const map = new Map<string, { count: number; duration: number }>();

    for (const track of tracks) {
      const genre = this._normalizeGenre(track.genre);
      const existing = map.get(genre) || { count: 0, duration: 0 };
      existing.count++;
      existing.duration += track.duration;
      map.set(genre, existing);
    }

    return Array.from(map.entries())
      .map(([genre, data]) => ({
        genre,
        trackCount: data.count,
        totalDuration: data.duration,
      }))
      .sort((a, b) => b.trackCount - a.trackCount); // Most tracks first
  }

  private _normalizeGenre(genre: string): string {
    const g = genre.trim();
    if (!g || g === 'Unknown') return 'Mixed';
    // Capitalize first letter of each word
    return g.replace(/\b\w/g, c => c.toUpperCase());
  }

  private _buildBlocks(genres: GenreGroup[]): ScheduleBlock[] {
    if (genres.length === 0) return [];

    const now = new Date();
    const blocks: ScheduleBlock[] = [];
    let blockIdx = 0;

    // Create blocks for each genre that has enough tracks (at least 3)
    const viable = genres.filter(g => g.trackCount >= 3);
    if (viable.length === 0) {
      // Fallback: single "Mixed" block
      viable.push({ genre: 'Mixed', trackCount: genres.reduce((s, g) => s + g.trackCount, 0), totalDuration: 0 });
    }

    // Build at least 6 blocks for a nice schedule view
    const targetBlocks = Math.max(6, viable.length);
    for (let i = 0; i < targetBlocks; i++) {
      const genreGroup = viable[i % viable.length];
      const startTime = new Date(now.getTime() + blockIdx * this._blockDuration * 60000);

      blocks.push({
        id: `block-${blockIdx}`,
        genre: genreGroup.genre,
        label: this._genreToLabel(genreGroup.genre),
        startTime,
        durationMinutes: this._blockDuration,
        trackCount: genreGroup.trackCount,
        isActive: false,
      });
      blockIdx++;
    }

    return blocks;
  }

  private _genreToLabel(genre: string): string {
    // Create a nice display label from genre name
    const labels: Record<string, string> = {
      'Electronic': 'Electronic Set',
      'House': 'House Hour',
      'Techno': 'Techno Session',
      'Hip Hop': 'Hip Hop Mix',
      'Hip-Hop': 'Hip Hop Mix',
      'Rap': 'Rap Session',
      'Pop': 'Pop Hits',
      'Rock': 'Rock Block',
      'Jazz': 'Jazz Vibes',
      'Classical': 'Classical Hour',
      'Ambient': 'Ambient Chill',
      'Chill': 'Chill Zone',
      'R&B': 'R&B Grooves',
      'Soul': 'Soul Session',
      'Drum And Bass': 'DnB Rush',
      'Dubstep': 'Bass Drop',
      'Trance': 'Trance Journey',
      'Reggae': 'Reggae Vibes',
      'Country': 'Country Roads',
      'Metal': 'Metal Hour',
      'Indie': 'Indie Picks',
      'Lo-Fi': 'Lo-Fi Beats',
      'Mixed': 'Mixed Set',
    };
    return labels[genre] || `${genre} Set`;
  }
}

/** Singleton schedule service */
export const scheduleService = new ScheduleService();
