/**
 * Library Service — Fetches and caches track data from the API.
 * Also manages music directories.
 * Exported as a singleton instance.
 */

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number | null;
}

export interface MusicDirectory {
  path: string;
}

class LibraryService {
  private cache: TrackInfo[] | null = null;
  private inflight: Promise<TrackInfo[]> | null = null;

  /**
   * Returns the cached track list, fetching from the API if not yet loaded.
   */
  async getTracks(): Promise<TrackInfo[]> {
    if (this.cache) {
      return this.cache;
    }
    return this.fetchTracks();
  }

  /**
   * Forces a fresh fetch from the API, replacing the cache.
   */
  async refresh(): Promise<TrackInfo[]> {
    this.cache = null;
    this.inflight = null;
    return this.fetchTracks();
  }

  /**
   * Get the list of watched music directories from the server.
   */
  async getDirectories(): Promise<MusicDirectory[]> {
    const response = await fetch('/api/directories');
    if (!response.ok) {
      throw new Error(`Failed to fetch directories: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Add a new music directory. Scans it and starts watching for changes.
   */
  async addDirectory(dirPath: string): Promise<{ path: string; added: number }> {
    const response = await fetch('/api/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(data.error || `Failed to add directory: ${response.status}`);
    }
    // Invalidate track cache since new tracks were added
    this.cache = null;
    this.inflight = null;
    return response.json();
  }

  private async fetchTracks(): Promise<TrackInfo[]> {
    // Deduplicate concurrent requests
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = (async () => {
      try {
        const response = await fetch('/api/tracks');
        if (!response.ok) {
          throw new Error(`Failed to fetch tracks: ${response.status} ${response.statusText}`);
        }
        const data: TrackInfo[] = await response.json();
        this.cache = data;
        return data;
      } catch (error) {
        this.inflight = null;
        throw error;
      }
    })();

    const result = await this.inflight;
    this.inflight = null;
    return result;
  }
}

export const libraryService = new LibraryService();
