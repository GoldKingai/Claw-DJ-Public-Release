import { aiDjService } from './ai-dj-service.js';
import { djEngineSync } from './dj-engine-sync.js';

import { libraryService } from '../library/library-service.js';

interface PlaybackCommand {
  id: string;
  action: 'pause' | 'resume' | 'skip' | 'stop' | 'shuffle' | 'clear' | 'enqueue' | 'play-track' | 'remove-queue-item';
  createdAt: number;
  params?: Record<string, unknown>;
  status?: string;
}

class PlaybackControlClient {
  private _timer: number | null = null;
  private seen = new Set<string>();

  start(): void {
    if (this._timer) return;
    const poll = async () => {
      try {
        const res = await fetch('/api/playback/history');
        if (!res.ok) return;
        const { history } = await res.json() as { history: PlaybackCommand[] };
        for (const command of history ?? []) {
          if (this.seen.has(command.id) || command.status === 'acked' || command.status === 'failed') continue;
          this.seen.add(command.id);
          if (this.seen.size > 500) this.seen = new Set(Array.from(this.seen).slice(-200));
          void this.apply(command);
        }
      } catch { /* network error */ }
    };
    void poll();
    this._timer = window.setInterval(poll, 2_000);
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  private async apply(command: PlaybackCommand): Promise<void> {
    try {
      switch (command.action) {
        case 'pause':
          aiDjService.pause();
          break;
        case 'resume':
          aiDjService.resume();
          break;
        case 'skip':
          await aiDjService.skipToNext();
          break;
        case 'stop':
          aiDjService.stop();
          break;
        case 'shuffle':
          aiDjService.shuffleQueue();
          break;
        case 'clear':
          aiDjService.clearQueue();
          break;
        case 'remove-queue-item': {
          const index = Number(command.params?.['index']);
          if (Number.isFinite(index)) aiDjService.removeFromQueue(index);
          break;
        }
        case 'enqueue': {
          const trackId = String(command.params?.['trackId'] ?? '');
          if (!trackId) throw new Error('trackId required');
          const tracks = await libraryService.getTracks();
          const track = tracks.find((item) => item.id === trackId);
          if (!track) throw new Error('track not found');
          aiDjService.enqueue({
            id: track.id,
            title: track.title,
            artist: track.artist,
            duration: track.duration,
            bpm: track.bpm,
            genre: track.genre,
          });
          break;
        }
        case 'play-track': {
          const trackId = String(command.params?.['trackId'] ?? '');
          if (!trackId) throw new Error('trackId required');
          const tracks = await libraryService.getTracks();
          const track = tracks.find((item) => item.id === trackId);
          if (!track) throw new Error('track not found');
          await aiDjService.playNow(track);
          break;
        }
      }
      await fetch(`/api/playback/ack/${command.id}`, { method: 'POST' }).catch(() => {});
      await djEngineSync.ackCommand();
    } catch (err) {
      await fetch(`/api/playback/fail/${command.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      }).catch(() => {});
    }
  }
}

export const playbackControlClient = new PlaybackControlClient();
