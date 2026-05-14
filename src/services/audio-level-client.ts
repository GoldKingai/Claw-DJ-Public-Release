/**
 * Audio Level Client
 *
 * Subscribes to /api/nowplaying/audio-level SSE and delivers
 * real-time RMS level data to registered callbacks.
 *
 * Usage:
 *   audioLevelClient.start(({ rms, bpm, positionSeconds }) => { ... });
 */

export interface AudioLevelFrame {
  rms: number;           // 0–1 linear RMS level from GStreamer
  bpm: number;           // current track BPM
  positionSeconds: number;
}

type AudioLevelCallback = (frame: AudioLevelFrame) => void;

class AudioLevelClient {
  private _sse: EventSource | null = null;
  private _listeners: Set<AudioLevelCallback> = new Set();

  start(cb: AudioLevelCallback): () => void {
    this._listeners.add(cb);
    if (!this._sse) this._connect();
    return () => {
      this._listeners.delete(cb);
      if (this._listeners.size === 0) this._disconnect();
    };
  }

  private _connect(): void {
    const es = new EventSource('/api/nowplaying/audio-level');
    es.onmessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(event.data as string) as AudioLevelFrame;
        this._listeners.forEach(cb => cb(frame));
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      es.close();
      this._sse = null;
      if (this._listeners.size > 0) {
        window.setTimeout(() => this._connect(), 5_000);
      }
    };
    this._sse = es;
  }

  private _disconnect(): void {
    if (this._sse) { this._sse.close(); this._sse = null; }
  }
}

export const audioLevelClient = new AudioLevelClient();
