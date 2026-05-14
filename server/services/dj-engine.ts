import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TrackStore } from '../utils/music-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '../data/dj-engine-state.json');

export interface DjQueuedTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  bpm: number | null;
  energy: number | null;
  genre: string;
}

export interface DjEngineState {
  mode: 'idle' | 'loading' | 'playing' | 'paused' | 'crossfading' | 'stopped';
  currentTrack: DjQueuedTrack | null;
  queue: DjQueuedTrack[];
  updatedAt: number;
  controllerOnline: boolean;
  lastControllerSeenAt: number;
  lastCommandAckAt: number;
}

class DjEngineService {
  private state: DjEngineState = {
    mode: 'idle',
    currentTrack: null,
    queue: [],
    updatedAt: Date.now(),
    controllerOnline: false,
    lastControllerSeenAt: 0,
    lastCommandAckAt: 0,
  };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as DjEngineState;
      }
    } catch (err) {
      console.warn('[DJ Engine] Failed to load state:', err);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[DJ Engine] Failed to save state:', err);
    }
  }

  snapshot(): DjEngineState {
    return JSON.parse(JSON.stringify(this.state)) as DjEngineState;
  }

  syncFromNowPlaying(input: Partial<DjEngineState> & { queue?: DjQueuedTrack[]; currentTrack?: DjQueuedTrack | null }): DjEngineState {
    this.state = {
      ...this.state,
      ...input,
      updatedAt: Date.now(),
    };
    this.save();
    return this.snapshot();
  }

  markControllerHeartbeat(): DjEngineState {
    this.state.controllerOnline = true;
    this.state.lastControllerSeenAt = Date.now();
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  markControllerOffline(): DjEngineState {
    this.state.controllerOnline = false;
    this.state.updatedAt = Date.now();
    this.save();
    return this.snapshot();
  }

  ackCommand(): void {
    this.state.lastCommandAckAt = Date.now();
    this.state.updatedAt = Date.now();
    this.save();
  }

  enqueueById(trackId: string): DjQueuedTrack | null {
    const track = TrackStore.getInstance().getById(trackId);
    if (!track) return null;
    const queued: DjQueuedTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      bpm: track.bpm,
      energy: track.energy,
      genre: track.genre,
    };
    this.state.queue.push(queued);
    this.state.updatedAt = Date.now();
    this.save();
    return queued;
  }

  clearQueue(): void {
    this.state.queue = [];
    this.state.updatedAt = Date.now();
    this.save();
  }
}

export const djEngine = new DjEngineService();
