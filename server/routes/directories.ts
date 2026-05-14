import { Router, type Request, type Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { TrackStore } from '../utils/music-scanner.js';
import { addWatchDirectory, getWatchedDirs, removeWatchDirectory } from '../utils/file-watcher.js';

const execAsync = promisify(exec);
const router = Router();

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

/**
 * Optional path-prefix whitelist. When ALLOWED_MUSIC_ROOTS is set in the
 * environment (comma-separated list of absolute paths), POST /api/directories
 * will only accept paths that resolve to a descendant of one of these roots.
 * Without this, any caller can probe arbitrary filesystem paths.
 *
 * Off by default to preserve existing trusted-LAN behaviour. Recommended
 * value: the user's intended music root(s), e.g. "D:/Music" or
 * "/path/to/your/music,/media/music".
 */
const ALLOWED_ROOTS: string[] | null = (() => {
  const raw = process.env.ALLOWED_MUSIC_ROOTS;
  if (!raw || !raw.trim()) return null;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => path.resolve(s));
})();

function pathWithinAllowedRoot(target: string): boolean {
  if (!ALLOWED_ROOTS) return true; // whitelist disabled
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  return ALLOWED_ROOTS.some(root => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    return t === r || t.startsWith(r + path.sep) || t.startsWith(r + '/');
  });
}

// ── GET /api/directories ─────────────────────────────────
// Returns the list of currently watched music directories with track counts.

router.get('/', (_req: Request, res: Response) => {
  const dirs = getWatchedDirs();
  res.json(dirs.map((d) => ({ path: d })));
});

// ── POST /api/directories ────────────────────────────────
// Add a new music directory. Body: { path: "D:/MyMusic" }
// Scans the directory and starts watching for changes.

router.post('/', async (req: Request, res: Response) => {
  const dirPath = req.body?.path;

  if (!dirPath || typeof dirPath !== 'string') {
    res.status(400).json({ error: 'Missing "path" in request body' });
    return;
  }

  const resolved = path.resolve(dirPath.trim());

  // Whitelist check (no-op unless ALLOWED_MUSIC_ROOTS is set in env).
  if (!pathWithinAllowedRoot(resolved)) {
    res.status(403).json({
      error: 'Path not allowed — must be within an ALLOWED_MUSIC_ROOTS entry',
    });
    return;
  }

  // Verify directory exists
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `Not a directory: ${resolved}` });
      return;
    }
  } catch {
    res.status(400).json({ error: `Directory not found: ${resolved}` });
    return;
  }

  // Check if already watched — Windows filesystem is case-insensitive,
  // so D:/Music and D:/music are the same directory. Compare lowercased
  // on win32 to prevent the same folder being added twice (which would
  // cause every track to be scanned and indexed twice).
  const watched = getWatchedDirs();
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const existing = watched.find(w => samePath(w, resolved));
  if (existing) {
    res.json({
      path: existing,
      added: 0,
      message: `Already watching this directory (as "${existing}")`,
    });
    return;
  }

  // Scan and start watching
  const store = TrackStore.getInstance();
  const added = await store.scanDirectories([resolved]);
  addWatchDirectory(resolved);

  console.log(`[directories] Added directory: ${resolved} (${added} tracks found)`);
  res.json({ path: resolved, added });
});

// ── DELETE /api/directories ──────────────────────────────
// Remove a watched directory. Body: { path: "D:/MyMusic" }

router.delete('/', (req: Request, res: Response) => {
  const dirPath = req.body?.path;
  if (!dirPath || typeof dirPath !== 'string') {
    res.status(400).json({ error: 'Missing "path" in request body' });
    return;
  }

  const resolved = path.resolve(dirPath.trim());
  const watched = getWatchedDirs();
  // Case-insensitive on Windows so "D:/music" matches a watched "D:/Music"
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const match = watched.find(w => samePath(w, resolved));

  if (!match) {
    res.status(404).json({ error: 'Directory not currently watched' });
    return;
  }

  // Stop watching + prune indexed tracks under this path so they disappear from
  // the library immediately (without requiring a server restart).
  const store = TrackStore.getInstance();
  const allTracks = store.getAll();
  const pruneRoot = process.platform === 'win32' ? match.toLowerCase() : match;
  let pruned = 0;
  for (const t of allTracks) {
    const tp = process.platform === 'win32' ? t.filePath.toLowerCase() : t.filePath;
    if (tp.startsWith(pruneRoot)) {
      store.removeFile(t.filePath);
      pruned++;
    }
  }

  // Stop watching this directory + remove it from the active list, so the
  // dashboard sidebar reflects reality after the REMOVE button is clicked.
  // Without this, the folder lingers in the UI even though tracks were pruned.
  removeWatchDirectory(match);

  // On Windows the case-insensitive match means we matched only one of two
  // possible case-variants. Walk the watched list and remove any other entries
  // pointing at the same physical directory (e.g. 'D:/music' when removing
  // 'D:/Music'). Otherwise duplicates re-appear after the next refresh.
  if (process.platform === 'win32') {
    for (const w of getWatchedDirs()) {
      if (w.toLowerCase() === match.toLowerCase()) {
        removeWatchDirectory(w);
      }
    }
  }

  console.log(`[directories] Removed directory: ${match} (pruned ${pruned} tracks)`);
  res.json({ path: match, removed: true, pruned });
});

// ── GET /api/directories/roots ───────────────────────────
// Returns mounted drives / common roots so the frontend folder picker can
// show drive letters (Windows) or mount points (Linux/macOS).
//
// Windows: scans A-Z for drive letters that exist
// Linux:   /, /home, /media/<user>/*, /mnt/*, $HOME
// macOS:   /, /Volumes/*, $HOME

router.get('/roots', async (_req: Request, res: Response) => {
  const roots: Array<{ path: string; label: string; type: string }> = [];

  if (process.platform === 'win32') {
    // Probe drive letters A: through Z:
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const drive = `${letter}:/`;
      try {
        await fsp.access(drive);
        // Try to get volume label using `wmic` (Windows-only)
        let label = `${letter}:`;
        try {
          const { stdout } = await execAsync(
            `wmic logicaldisk where "DeviceID='${letter}:'" get VolumeName /value`,
            { timeout: 2000 }
          );
          const m = stdout.match(/VolumeName=(.+)/);
          if (m && m[1].trim()) label = `${letter}: ${m[1].trim()}`;
        } catch {
          // wmic unavailable — fall back to just the letter
        }
        roots.push({ path: drive, label, type: 'drive' });
      } catch {
        // Drive doesn't exist
      }
    }
  } else {
    // Linux / macOS
    roots.push({ path: '/', label: 'Root /', type: 'root' });
    const home = os.homedir();
    if (home) roots.push({ path: home, label: `Home (${path.basename(home)})`, type: 'home' });

    // Try /media/<user>/* (Linux), /Volumes/* (macOS)
    const mountDirs = process.platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt', '/run/media'];
    for (const md of mountDirs) {
      try {
        const entries = await fsp.readdir(md, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const full = path.join(md, e.name);
          // On Linux /media/<user>/<device> is the actual mount; descend one level
          if (md === '/media' || md === '/run/media') {
            try {
              const inner = await fsp.readdir(full, { withFileTypes: true });
              for (const i of inner) {
                if (i.isDirectory()) {
                  roots.push({
                    path: path.join(full, i.name),
                    label: i.name,
                    type: 'usb',
                  });
                }
              }
            } catch {
              roots.push({ path: full, label: e.name, type: 'usb' });
            }
          } else {
            roots.push({ path: full, label: e.name, type: 'usb' });
          }
        }
      } catch {
        // Mount dir doesn't exist on this system
      }
    }
  }

  res.json({ roots });
});

// ── GET /api/directories/browse?path=<path> ──────────────
// Returns subdirectories at the given path. Used by the folder picker UI
// to navigate the filesystem tree. Also reports how many audio files are
// directly inside the path (preview count before scanning).

router.get('/browse', async (req: Request, res: Response) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  const target = raw ? path.resolve(raw) : (process.platform === 'win32' ? 'C:/' : '/');

  // Whitelist check (no-op unless ALLOWED_MUSIC_ROOTS is set in env).
  if (!pathWithinAllowedRoot(target)) {
    res.status(403).json({
      error: 'Path not allowed — must be within an ALLOWED_MUSIC_ROOTS entry',
    });
    return;
  }

  try {
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `Not a directory: ${target}` });
      return;
    }
  } catch (e) {
    res.status(404).json({ error: `Cannot access: ${target} (${(e as Error).message})` });
    return;
  }

  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (e) {
    res.status(403).json({ error: `Permission denied: ${target} (${(e as Error).message})` });
    return;
  }

  const dirs: Array<{ name: string; path: string }> = [];
  let audioCount = 0;

  for (const entry of entries) {
    // Skip hidden files/folders (starting with .) and Windows system folders
    if (entry.name.startsWith('.')) continue;
    if (entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: path.join(target, entry.name) });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) audioCount++;
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    path: target,
    parent: path.dirname(target) !== target ? path.dirname(target) : null,
    directories: dirs,
    audioCount,
  });
});

export default router;
