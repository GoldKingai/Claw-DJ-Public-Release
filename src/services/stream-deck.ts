/**
 * StreamDeck — Web Audio API dual-deck player for the OBS Browser Source.
 *
 * Receives play commands via SSE from /api/deck-stream/commands.
 * Plays audio through the Web Audio API so OBS can capture it via
 * "Control audio via OBS" on the Browser Source.
 * Reports playback state back to /api/deck-stream/state every 200 ms.
 *
 * Deck model:
 *   activeDeck  — currently playing
 *   spareDeck   — preloaded track waiting for crossfade
 *
 * Command flow:
 *   play    → load + start on activeDeck
 *   preload → fetch + decode onto spareDeck (no playback yet)
 *   crossfade → start spareDeck, ramp activeDeck→0, swap active/spare
 */

interface DeckState {
  trackId: string | null;
  title: string | null;
  artist: string | null;
  duration: number;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  startedAt: number;   // AudioContext.currentTime when source.start() was called
  pausedOffset: number; // seconds into track when paused
  playing: boolean;
}

type DeckId = 'a' | 'b';

class StreamDeck {
  // Audio graph — lazily created on first command (avoids autoplay block)
  private _ctx: AudioContext | null = null;
  private _decks: Record<DeckId, DeckState> | null = null;
  private _analyser: AnalyserNode | null = null;
  private _masterGain: GainNode | null = null;
  private _silencerGain: GainNode | null = null;
  // When true, the browser-deck IS the audio source (Windows local mode, or
  // any setup where mpv isn't producing audio). When false (Ayla default),
  // audio is silenced because mpv→PipeWire is the real source and the browser
  // is purely for visualization.
  private _audible = false;

  private _activeDeck: DeckId = 'a';
  private _mode: 'idle' | 'playing' | 'paused' | 'error' = 'idle';
  private _volume = 1;
  private _eosCount = 0;
  private _lastError = '';

  private _eventSource: EventSource | null = null;
  private _reportTimer: ReturnType<typeof setInterval> | null = null;
  private _crossfadeTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  getAnalyser(): AnalyserNode | null { return this._analyser; }

  /**
   * Make the browser-deck audibly play through speakers (default false).
   *
   * - `true`  → laptop speakers play audio (Windows local mode, or any
   *             scenario where mpv isn't running).
   * - `false` → silenced; only the analyser receives data. Use this when
   *             mpv→PipeWire is the real audio source (Ayla's setup —
   *             prevents double-output).
   *
   * Safe to call before or after the AudioContext is created.
   */
  setAudible(on: boolean): void {
    this._audible = on;
    if (this._silencerGain && this._ctx) {
      const g = this._silencerGain.gain;
      g.cancelScheduledValues(this._ctx.currentTime);
      g.linearRampToValueAtTime(on ? 1 : 0, this._ctx.currentTime + 0.05);
    }
  }

  isAudible(): boolean { return this._audible; }

  getPosition(): number { return this._getPosition(); }

  getDuration(): number {
    if (!this._decks) return 0;
    return this._decks[this._activeDeck].duration;
  }

  /** Duck music volume for TTS — ramps master gain down. */
  duck(targetVol = 0.15, rampSecs = 0.4): void {
    if (!this._ctx || !this._masterGain) return;
    const g = this._masterGain.gain;
    g.cancelScheduledValues(this._ctx.currentTime);
    g.setValueAtTime(g.value, this._ctx.currentTime);
    g.linearRampToValueAtTime(targetVol, this._ctx.currentTime + rampSecs);
  }

  /** Restore music volume after TTS. */
  unduck(rampSecs = 0.8): void {
    if (!this._ctx || !this._masterGain) return;
    const g = this._masterGain.gain;
    g.cancelScheduledValues(this._ctx.currentTime);
    g.setValueAtTime(g.value, this._ctx.currentTime);
    g.linearRampToValueAtTime(1.0, this._ctx.currentTime + rampSecs);
  }

  getRms(): number {
    if (!this._analyser) return 0;
    const buf = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const s = (v - 128) / 128; sum += s * s; }
    return Math.sqrt(sum / buf.length);
  }

  /** Start listening for deck commands from the server. */
  start(): void {
    if (this._eventSource) return;
    this._connect();
    this._reportTimer = setInterval(() => this._postState(), 200);
    // Auto-unlock AudioContext on the first user interaction so SSE-triggered
    // plays work without requiring a manual click.
    const onGesture = () => {
      void this.unlock();
      document.removeEventListener('click', onGesture);
      document.removeEventListener('keydown', onGesture);
    };
    document.addEventListener('click', onGesture);
    document.addEventListener('keydown', onGesture);
  }

  /**
   * Call this during a user gesture (e.g. button click) to pre-unlock the
   * AudioContext so subsequent SSE-triggered play commands don't hang on
   * ctx.resume().
   */
  async unlock(): Promise<void> {
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
  }

  /** Stop listening and tear down audio. */
  stop(): void {
    this._eventSource?.close();
    this._eventSource = null;
    if (this._reportTimer) { clearInterval(this._reportTimer); this._reportTimer = null; }
    if (this._crossfadeTimeout) { clearTimeout(this._crossfadeTimeout); this._crossfadeTimeout = null; }
    this._ctx?.close();
    this._ctx = null;
    this._decks = null;
    this._analyser = null;
  }

  // ── SSE connection ──────────────────────────────────────────────────────────

  private _connect(): void {
    this._eventSource = new EventSource('/api/deck-stream/commands');
    this._eventSource.onopen = () => {
      console.log('[streamDeck] SSE connected — listening for deck commands');
    };
    this._eventSource.onmessage = (e) => {
      try {
        const cmd = JSON.parse(e.data as string) as Record<string, unknown>;
        console.log('[streamDeck] cmd:', cmd['type'], cmd);
        this._handleCommand(cmd);
      } catch (err) {
        console.warn('[streamDeck] malformed SSE message:', err, e.data);
      }
    };
    this._eventSource.onerror = (err) => {
      console.warn('[streamDeck] SSE error — will auto-reconnect', err);
    };
  }

  // ── Audio context (lazy init) ───────────────────────────────────────────────

  private _ensureCtx(): AudioContext {
    if (this._ctx) return this._ctx;

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const master = ctx.createGain();
    master.connect(analyser);
    // Routing gain to destination. When _audible=true (Windows local mode / no
    // mpv), gain = 1 so audio plays through laptop speakers. When _audible=false
    // (Ayla default — mpv→PipeWire is the audio source, browser is visual-only),
    // gain = 0 so the Web Audio graph still processes for the analyser but
    // doesn't double-output.
    const silencer = ctx.createGain();
    silencer.gain.value = this._audible ? 1 : 0;
    analyser.connect(silencer);
    silencer.connect(ctx.destination);
    this._silencerGain = silencer;

    const makeDeck = (): DeckState => ({
      trackId: null, title: null, artist: null, duration: 0,
      buffer: null, source: null,
      gain: (() => { const g = ctx.createGain(); g.connect(master); return g; })(),
      startedAt: 0, pausedOffset: 0, playing: false,
    });

    this._ctx = ctx;
    this._analyser = analyser;
    this._masterGain = master;
    this._decks = { a: makeDeck(), b: makeDeck() };
    return ctx;
  }

  private get _spareDeck(): DeckId {
    return this._activeDeck === 'a' ? 'b' : 'a';
  }

  // ── Command dispatch ────────────────────────────────────────────────────────

  private _handleCommand(cmd: Record<string, unknown>): void {
    switch (cmd['type']) {
      case 'play':
        void this._play(
          String(cmd['trackId'] ?? ''),
          String(cmd['audioUrl'] ?? ''),
          cmd['title'] as string | undefined,
          cmd['artist'] as string | undefined,
          Number(cmd['duration'] ?? 0),
        );
        break;
      case 'preload':
        void this._preload(
          String(cmd['trackId'] ?? ''),
          String(cmd['audioUrl'] ?? ''),
          cmd['title'] as string | undefined,
          cmd['artist'] as string | undefined,
          Number(cmd['duration'] ?? 0),
        );
        break;
      case 'crossfade':
        this._crossfade(Number(cmd['durationSeconds'] ?? 6));
        break;
      case 'pause':   this._pause();   break;
      case 'resume':  this._resume();  break;
      case 'stop':    this._stop();    break;
      case 'seek':    this._seek(Number(cmd['positionSeconds'] ?? 0)); break;
      case 'set-volume': this._setVolume(Number(cmd['volume'] ?? 1)); break;
      case 'duck':    this.duck(Number(cmd['targetVol'] ?? 0.15), Number(cmd['rampSecs'] ?? 0.4)); break;
      case 'unduck':  this.unduck(Number(cmd['rampSecs'] ?? 0.8)); break;
      case 'fade-to': this._fadeTo(Number(cmd['volume'] ?? 1), Number(cmd['rampSecs'] ?? 1)); break;
    }
  }

  // ── Playback commands ───────────────────────────────────────────────────────

  private async _play(trackId: string, audioUrl: string, title?: string, artist?: string, duration = 0): Promise<void> {
    console.log('[streamDeck] _play:', { trackId, audioUrl, title, audible: this._audible });
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      console.log('[streamDeck] AudioContext suspended — resuming...');
      await ctx.resume();
      console.log('[streamDeck] AudioContext state after resume:', ctx.state);
    }

    // Stop the currently active deck
    this._stopDeck(this._activeDeck);

    const deck = this._decks![this._activeDeck];
    deck.trackId = trackId;
    deck.title = title ?? null;
    deck.artist = artist ?? null;

    try {
      // Fetch + decode (or reuse buffer if trackId matches a preloaded spare)
      const spare = this._decks![this._spareDeck];
      if (spare.trackId === trackId && spare.buffer) {
        deck.buffer = spare.buffer;
        spare.buffer = null;
        spare.trackId = null;
        console.log('[streamDeck] _play: reused preloaded spare buffer');
      } else {
        const resp = await fetch(audioUrl);
        if (!resp.ok) {
          throw new Error(`Fetch ${audioUrl} failed: HTTP ${resp.status}`);
        }
        const ab = await resp.arrayBuffer();
        console.log('[streamDeck] _play: fetched', ab.byteLength, 'bytes, decoding...');
        deck.buffer = await ctx.decodeAudioData(ab);
        console.log('[streamDeck] _play: decoded', deck.buffer.duration.toFixed(1), 's');
      }
      deck.duration = deck.buffer.duration || duration;

      deck.gain.gain.setValueAtTime(this._volume, ctx.currentTime);

      const source = ctx.createBufferSource();
      source.buffer = deck.buffer;
      source.connect(deck.gain);
      source.onended = () => this._onDeckEnded(this._activeDeck, deck);
      source.start(0);

      deck.source = source;
      deck.startedAt = ctx.currentTime;
      deck.pausedOffset = 0;
      deck.playing = true;

      this._mode = 'playing';
      this._lastError = '';
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._mode = 'error';
      console.error('[StreamDeck] play failed:', err);
    }

    this._postState();
  }

  private async _preload(trackId: string, audioUrl: string, title?: string, artist?: string, duration = 0): Promise<void> {
    const ctx = this._ensureCtx();
    const deck = this._decks![this._spareDeck];

    // Stop any playing source on spare deck before overwriting
    this._stopDeck(this._spareDeck);

    deck.trackId = trackId;
    deck.title = title ?? null;
    deck.artist = artist ?? null;
    deck.buffer = null;

    try {
      const resp = await fetch(audioUrl);
      const ab = await resp.arrayBuffer();
      deck.buffer = await ctx.decodeAudioData(ab);
      deck.duration = deck.buffer.duration || duration;
      console.log(`[StreamDeck] Preloaded ${trackId} on spare deck`);
    } catch (err) {
      console.error('[StreamDeck] preload failed:', err);
    }
  }

  private _crossfade(durationSeconds: number): void {
    const ctx = this._ensureCtx();
    const fromId = this._activeDeck;
    const toId = this._spareDeck;
    const toDeck = this._decks![toId];
    const fromDeck = this._decks![fromId];

    if (!toDeck.buffer) {
      console.warn('[StreamDeck] crossfade: spare deck has no preloaded buffer, skipping');
      return;
    }

    // Start spare deck from position 0
    if (!toDeck.playing) {
      const source = ctx.createBufferSource();
      source.buffer = toDeck.buffer;
      source.connect(toDeck.gain);
      source.onended = () => this._onDeckEnded(toId, toDeck);
      toDeck.gain.gain.setValueAtTime(0, ctx.currentTime);
      source.start(0);
      toDeck.source = source;
      toDeck.startedAt = ctx.currentTime;
      toDeck.pausedOffset = 0;
      toDeck.playing = true;
    }

    // Ramp old deck out, new deck in
    const now = ctx.currentTime;
    const end = now + durationSeconds;
    fromDeck.gain.gain.linearRampToValueAtTime(0, end);
    toDeck.gain.gain.linearRampToValueAtTime(this._volume, end);

    // After fade completes, stop and free the old deck
    if (this._crossfadeTimeout) clearTimeout(this._crossfadeTimeout);
    this._crossfadeTimeout = setTimeout(() => {
      this._stopDeck(fromId);
    }, durationSeconds * 1000 + 100);

    // The incoming deck is now active
    this._activeDeck = toId;
    this._mode = 'playing';
    this._postState();
  }

  private _pause(): void {
    if (this._mode !== 'playing') return;
    const ctx = this._ctx;
    if (!ctx || !this._decks) return;
    const deck = this._decks[this._activeDeck];
    if (deck.source && deck.playing) {
      deck.pausedOffset = ctx.currentTime - deck.startedAt;
      try { deck.source.stop(); } catch { /* already ended */ }
      deck.source = null;
      deck.playing = false;
    }
    this._mode = 'paused';
    this._postState();
  }

  private _resume(): void {
    if (this._mode !== 'paused') return;
    const ctx = this._ensureCtx();
    const deck = this._decks![this._activeDeck];
    if (!deck.buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = deck.buffer;
    source.connect(deck.gain);
    source.onended = () => this._onDeckEnded(this._activeDeck, deck);
    const offset = Math.min(deck.pausedOffset, deck.buffer.duration - 0.001);
    source.start(0, offset);

    deck.source = source;
    deck.startedAt = ctx.currentTime - offset;
    deck.pausedOffset = 0;
    deck.playing = true;
    this._mode = 'playing';
    this._postState();
  }

  private _stop(): void {
    this._stopDeck('a');
    this._stopDeck('b');
    this._mode = 'idle';
    this._eosCount = 0;
    this._lastError = '';
    this._postState();
  }

  private _seek(positionSeconds: number): void {
    if (!this._ctx || !this._decks) return;
    const ctx = this._ctx;
    const deck = this._decks[this._activeDeck];
    if (!deck.buffer) return;

    const wasPlaying = deck.playing;
    this._stopDeck(this._activeDeck);

    const offset = Math.min(Math.max(0, positionSeconds), deck.buffer.duration - 0.001);

    if (wasPlaying) {
      const source = ctx.createBufferSource();
      source.buffer = deck.buffer;
      source.connect(deck.gain);
      source.onended = () => this._onDeckEnded(this._activeDeck, deck);
      source.start(0, offset);
      deck.source = source;
      deck.startedAt = ctx.currentTime - offset;
      deck.pausedOffset = 0;
      deck.playing = true;
    } else {
      deck.pausedOffset = offset;
    }
    this._postState();
  }

  private _setVolume(vol: number): void {
    this._volume = Math.max(0, Math.min(1, vol));
    if (!this._ctx || !this._decks) return;
    const deck = this._decks[this._activeDeck];
    deck.gain.gain.setValueAtTime(this._volume, this._ctx.currentTime);
  }

  /** Ramp master gain to target volume over rampSecs (for fade-in / fade-out). */
  private _fadeTo(targetVol: number, rampSecs: number): void {
    if (!this._ctx || !this._masterGain) return;
    const g = this._masterGain.gain;
    g.cancelScheduledValues(this._ctx.currentTime);
    g.setValueAtTime(g.value, this._ctx.currentTime);
    g.linearRampToValueAtTime(Math.max(0, Math.min(1, targetVol)), this._ctx.currentTime + rampSecs);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _stopDeck(id: DeckId): void {
    const deck = this._decks?.[id];
    if (!deck) return;
    if (deck.source) {
      try { deck.source.stop(); } catch { /* already stopped */ }
      deck.source = null;
    }
    deck.playing = false;
  }

  /** Called when an AudioBufferSourceNode fires its onended event. */
  private _onDeckEnded(id: DeckId, deck: DeckState): void {
    if (!deck.playing) return; // Already handled (e.g. manually stopped)
    deck.playing = false;
    deck.source = null;
    // Only increment eosCount and go idle if this was the active deck
    if (id === this._activeDeck) {
      this._eosCount++;
      this._mode = 'idle';
      this._postState(); // Immediate report so engine detects EOS quickly
    }
  }

  private _getPosition(): number {
    if (!this._ctx || !this._decks) return 0;
    const deck = this._decks[this._activeDeck];
    if (!deck.playing) return deck.pausedOffset;
    return Math.max(0, this._ctx.currentTime - deck.startedAt);
  }

  private _postState(): void {
    if (!this._decks) return;
    const deck = this._decks[this._activeDeck];
    const state = {
      mode: this._mode,
      activeDeck: this._activeDeck,
      positionSeconds: this._getPosition(),
      durationSeconds: deck.duration,
      volume: this._volume,
      eosCount: this._eosCount,
      rms: this.getRms(),
      currentTrackId: deck.trackId,
      currentTrackTitle: deck.title,
      currentTrackArtist: deck.artist,
      lastError: this._lastError,
      updatedAt: Date.now(),
    };
    fetch('/api/deck-stream/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => { /* swallow — server may be temporarily unreachable */ });
  }
}

export const streamDeck = new StreamDeck();
