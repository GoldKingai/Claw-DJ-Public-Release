import { parseFile } from 'music-metadata';
import path from 'node:path';

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  bpm: number | null;
  /** Energy level 1–10 from Ghost's TXXX:ENERGY ID3 tag. null for non-Ghost tracks. */
  energy: number | null;
}

/**
 * Parse a filename into a best-guess title and artist.
 * Handles patterns like "Artist - Title.mp3" or just "Title.mp3".
 */
function parseFilename(filePath: string): { title: string; artist: string } {
  const basename = path.basename(filePath, path.extname(filePath));
  const dashIndex = basename.indexOf(' - ');
  if (dashIndex !== -1) {
    return {
      artist: basename.slice(0, dashIndex).trim(),
      title: basename.slice(dashIndex + 3).trim(),
    };
  }
  return { title: basename.trim(), artist: 'Unknown Artist' };
}

/**
 * Read metadata (ID3 / Vorbis / etc.) from an audio file.
 * Falls back to filename parsing when tags are missing.
 */
export async function readMetadata(filePath: string): Promise<TrackMetadata> {
  const fallback = parseFilename(filePath);

  try {
    const metadata = await parseFile(filePath, { duration: true });
    const { common, format } = metadata;

    const title = common.title?.trim() || fallback.title;
    const artist = common.artist?.trim() || fallback.artist;
    const album = common.album?.trim() || 'Unknown Album';
    const genre = common.genre?.[0]?.trim() || 'Unknown';
    const duration = format.duration ?? 0;
    const bpm = common.bpm ?? null;
    const txxx = (common as unknown as Record<string, unknown>)['userDefinedText'] as Array<{ description: string; value: string }> | undefined;
    const energyTag = txxx?.find((t) => t.description === 'ENERGY');
    const energy = energyTag ? (parseInt(energyTag.value, 10) || null) : null;

    return { title, artist, album, genre, duration, bpm, energy };
  } catch (err) {
    console.warn(`[metadata-reader] Failed to read tags for ${filePath}:`, (err as Error).message);
    return {
      title: fallback.title,
      artist: fallback.artist,
      album: 'Unknown Album',
      genre: 'Unknown',
      duration: 0,
      bpm: null,
      energy: null,
    };
  }
}
