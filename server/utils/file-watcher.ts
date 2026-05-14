import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { TrackStore } from './music-scanner.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a']);

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

let watcher: FSWatcher | null = null;
let watchedDirs: string[] = [];

/**
 * Start watching the given directories (and any new USB-mounted paths that
 * appear under them) for audio file additions and removals.
 */
export function startWatching(dirs: string[]): FSWatcher {
  const store = TrackStore.getInstance();
  watchedDirs = dirs.map((d) => path.resolve(d));

  watcher = chokidar.watch(dirs, {
    persistent: true,
    ignoreInitial: true, // we already did the initial scan
    // Symlink-follow disabled to avoid:
    //   1. Symlink loops eating CPU at scan time
    //   2. Watching paths outside the intended music dir via crafted links
    // Set FILE_WATCHER_FOLLOW_SYMLINKS=true in env if you actually rely on
    // symlinked album folders.
    followSymlinks: process.env.FILE_WATCHER_FOLLOW_SYMLINKS === 'true',
    ignored: (targetPath, stats) => {
      const normalized = targetPath.toString();
      if (normalized.includes('/lost+found')) return true;
      if (stats?.isDirectory() && normalized.endsWith('/System Volume Information')) return true;
      return false;
    },
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
    // Depth is unlimited by default — handles nested folders & USB mount points
  });

  watcher.on('add', async (filePath: string) => {
    if (!isAudioFile(filePath)) return;
    const track = await store.addFile(filePath);
    if (track) {
      console.log(`[file-watcher] Added: ${track.artist} - ${track.title}  (${track.fileName})`);
    }
  });

  watcher.on('unlink', (filePath: string) => {
    if (!isAudioFile(filePath)) return;
    const removed = store.removeFile(filePath);
    if (removed) {
      console.log(`[file-watcher] Removed: ${path.basename(filePath)}`);
    }
  });

  watcher.on('error', (err) => {
    console.error('[file-watcher] Error:', (err as Error).message);
  });

  console.log(`[file-watcher] Watching ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'} for changes`);
  return watcher;
}

/**
 * Add a new directory to the watcher at runtime.
 * Case-insensitive duplicate check on Windows.
 */
export function addWatchDirectory(dir: string): void {
  const resolved = path.resolve(dir);
  const isWin = process.platform === 'win32';
  const exists = watchedDirs.some(w =>
    isWin ? w.toLowerCase() === resolved.toLowerCase() : w === resolved
  );
  if (exists) return;

  watchedDirs.push(resolved);
  if (watcher) {
    watcher.add(resolved);
    console.log(`[file-watcher] Now also watching: ${resolved}`);
  }
}

/**
 * Stop watching a directory and remove it from the active list.
 * Case-insensitive match on Windows so 'D:/music' removes 'D:/Music' too.
 * Returns true if a directory was removed.
 */
export function removeWatchDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  const isWin = process.platform === 'win32';
  const match = watchedDirs.find(w =>
    isWin ? w.toLowerCase() === resolved.toLowerCase() : w === resolved
  );
  if (!match) return false;

  watchedDirs = watchedDirs.filter(w => w !== match);
  if (watcher) {
    watcher.unwatch(match);
    console.log(`[file-watcher] Stopped watching: ${match}`);
  }
  return true;
}

/**
 * Returns the list of currently watched directories.
 */
export function getWatchedDirs(): string[] {
  return [...watchedDirs];
}

/**
 * Stop watching (used for graceful shutdown).
 */
export async function stopWatching(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log('[file-watcher] Stopped watching.');
  }
}
