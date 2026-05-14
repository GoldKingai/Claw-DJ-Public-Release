/**
 * TTS Client
 *
 * Subscribes to /api/tts/stream SSE. When a speech event arrives,
 * plays the WAV audio and invokes callbacks for lip-sync.
 *
 * Usage:
 *   ttsClient.start(({ text, durationMs }) => { avatar.speak(text, durationMs); });
 */

export interface TtsEvent {
  id: string;
  text: string;
  audioUrl: string;
  durationMs: number;
}

type TtsCallback = (event: TtsEvent) => void;

class TtsClient {
  private _sse: EventSource | null = null;
  private _listeners: Set<TtsCallback> = new Set();
  private _audioCtx: AudioContext | null = null;

  start(cb: TtsCallback): () => void {
    this._listeners.add(cb);
    if (!this._sse) this._connect();
    return () => {
      this._listeners.delete(cb);
      if (this._listeners.size === 0) this._disconnect();
    };
  }

  private _connect(): void {
    const es = new EventSource('/api/tts/stream');
    es.onmessage = (event: MessageEvent) => {
      try {
        const ttsEvent = JSON.parse(event.data as string) as TtsEvent;
        void this._playAndNotify(ttsEvent);
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

  private async _playAndNotify(ttsEvent: TtsEvent): Promise<void> {
    // Notify listeners first (lip-sync starts with audio)
    this._listeners.forEach(cb => cb(ttsEvent));

    // Play the WAV through Web Audio (routed through the browser, NOT GStreamer)
    // This keeps TTS audio out of the OBS stream — OBS only captures GStreamer music.
    // TTS goes through the OBS browser source audio track directly.
    try {
      if (!this._audioCtx) {
        this._audioCtx = new AudioContext();
      }
      const res = await fetch(ttsEvent.audioUrl);
      const buf = await res.arrayBuffer();
      const decoded = await this._audioCtx.decodeAudioData(buf);
      const source = this._audioCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(this._audioCtx.destination);
      source.start();
    } catch (err) {
      console.warn('[TtsClient] Audio playback failed:', (err as Error).message);
    }
  }

  private _disconnect(): void {
    if (this._sse) { this._sse.close(); this._sse = null; }
  }
}

export const ttsClient = new TtsClient();
