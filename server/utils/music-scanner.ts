import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readMetadata, type TrackMetadata } from './metadata-reader.js';

/**
 * Derive a stable UUID-shaped ID from a file path.
 * Same absolute path → same ID across restarts, so saved queue IDs stay valid.
 */
/**
 * Canonicalise a path before hashing so the same physical file always produces
 * the same ID. Windows filesystems are case-insensitive — D:/Music/x.mp3 and
 * D:/music/x.mp3 are the same file but resolve to different strings via
 * path.resolve(), which would hash to different IDs without this normalisation.
 */
function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathToId(filePath: string): string {
  const h = createHash('sha1').update(canonicalPath(filePath)).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a']);

export interface Track extends TrackMetadata {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  format: string;
  addedAt: string;
  valid: boolean;  // false if ffprobe rejects the file
}


// One-time flag — once we detect ffprobe is missing, stop trying to spawn it.
let _ffprobeMissing = false;

/**
 * Quick ffprobe validation — resolves true if file has a readable audio stream.
 * If ffprobe binary is not installed (Windows without ffmpeg), this trusts the
 * file extension instead of marking every track as invalid.
 */
async function probeAudio(filePath: string): Promise<boolean> {
  if (_ffprobeMissing) return true; // trust extension when no ffprobe available
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0',
       '-show_entries', 'stream=codec_type',
       '-of', 'default=noprint_wrappers=1',
       filePath],
      { timeout: 8000 },
      (err, stdout) => {
        // ENOENT means ffprobe isn't installed. Mark flag so we don't keep
        // hammering spawn on every file (each spawn fail is slow on Windows).
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (!_ffprobeMissing) {
            _ffprobeMissing = true;
            console.warn('[music-scanner] ffprobe not installed — trusting file extensions for audio validation. Install ffmpeg for stricter validation.');
          }
          resolve(true);
          return;
        }
        resolve(!err && stdout.includes('codec_type=audio'));
      },
    );
  });
}

/**
 * Singleton store that holds all discovered tracks in memory.
 * Provides methods to scan directories, add/remove individual files,
 * and query the track list.
 */
export class TrackStore {
  private static instance: TrackStore;
  private tracks: Map<string, Track> = new Map();
  /** Reverse lookup: absolute file path -> track id */
  private pathIndex: Map<string, string> = new Map();

  private constructor() {}

  static getInstance(): TrackStore {
    if (!TrackStore.instance) {
      TrackStore.instance = new TrackStore();
    }
    return TrackStore.instance;
  }

  // ── Queries ────────────────────────────────────────────────

  getAll(): Track[] {
    return Array.from(this.tracks.values());
  }

  getById(id: string): Track | undefined {
    return this.tracks.get(id);
  }

  getByPath(filePath: string): Track | undefined {
    const id = this.pathIndex.get(canonicalPath(filePath));
    return id ? this.tracks.get(id) : undefined;
  }

  get count(): number {
    return this.tracks.size;
  }

  // ── Mutations ──────────────────────────────────────────────

  async addFile(filePath: string): Promise<Track | null> {
    const resolved = path.resolve(filePath);
    const key = canonicalPath(filePath); // case-insensitive on Windows
    if (this.pathIndex.has(key)) return this.tracks.get(this.pathIndex.get(key)!)!;
    if (!isAudioFile(resolved)) return null;

    try {
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) return null;

      const metadata = await readMetadata(resolved);
      const valid = await probeAudio(resolved);
      if (!valid) {
        console.warn(`[music-scanner] Invalid audio (ffprobe rejected): ${path.basename(resolved)}`);
      }
      const track: Track = {
        id: pathToId(resolved),
        filePath: resolved,
        fileName: path.basename(resolved),
        fileSize: stat.size,
        format: path.extname(resolved).slice(1).toLowerCase(),
        addedAt: new Date().toISOString(),
        valid,
        ...metadata,
      };

      this.tracks.set(track.id, track);
      this.pathIndex.set(key, track.id);
      return track;
    } catch (err) {
      console.warn(`[music-scanner] Could not add ${resolved}:`, (err as Error).message);
      return null;
    }
  }

  removeFile(filePath: string): boolean {
    const key = canonicalPath(filePath);
    const id = this.pathIndex.get(key);
    if (!id) return false;
    this.tracks.delete(id);
    this.pathIndex.delete(key);
    return true;
  }

  // ── Bulk scan ──────────────────────────────────────────────

  /**
   * Recursively scan one or more directories and add every audio file found.
   * Returns the number of new tracks added.
   */
  async scanDirectories(dirs: string[]): Promise<number> {
    let added = 0;
    for (const dir of dirs) {
      added += await this.scanDir(dir);
    }
    return added;
  }

  private async scanDir(dir: string): Promise<number> {
    let added = 0;
    const resolved = path.resolve(dir);

    try {
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      const promises: Promise<void>[] = [];

      for (const entry of entries) {
        const fullPath = path.join(resolved, entry.name);
        if (entry.isDirectory() && (entry.name === 'lost+found' || entry.name === 'System Volume Information')) {
          continue;
        }
        if (entry.isDirectory()) {
          promises.push(
            this.scanDir(fullPath).then((n) => {
              added += n;
            }),
          );
        } else if (entry.isFile() && isAudioFile(fullPath)) {
          promises.push(
            this.addFile(fullPath).then((t) => {
              if (t) added++;
            }),
          );
        }
      }

      await Promise.all(promises);
    } catch (err) {
      console.warn(`[music-scanner] Could not scan ${resolved}:`, (err as Error).message);
    }
    return added;
  }
}

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
