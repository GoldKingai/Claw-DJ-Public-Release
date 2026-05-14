import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

import audioEngine from '../playback/audio-engine.js';
import { DeckPlayer } from '../playback/deck-player.js';
import type { DeckPanel } from './deck-panel.js';
import type { MixerPanel } from './mixer-panel.js';

import './deck-panel.js';
import './mixer-panel.js';

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  url?: string;
}

/**
 * Top-level DJ console container.
 * Arranges [Deck A] [Mixer] [Deck B] horizontally.
 * Manages audio engine init, deck players, and the animation loop.
 */
@customElement('dj-console')
export class DjConsole extends LitElement {
  // ── Deck A state ──
  @state() private _trackA: TrackInfo | null = null;
  @state() private _playingA = false;
  @state() private _timeA = 0;
  @state() private _durationA = 0;
  @state() private _bpmA = 120;
  @state() private _peakA = 0;

  // ── Deck B state ──
  @state() private _trackB: TrackInfo | null = null;
  @state() private _playingB = false;
  @state() private _timeB = 0;
  @state() private _durationB = 0;
  @state() private _bpmB = 120;
  @state() private _peakB = 0;

  // ── Shared state ──
  @state() private _crossfade = 0.5;
  @state() private _initialized = false;

  private _playerA: DeckPlayer | null = null;
  private _playerB: DeckPlayer | null = null;
  private _animFrameId = 0;

  @query('#deck-a') private _deckPanelA!: DeckPanel;
  @query('#deck-b') private _deckPanelB!: DeckPanel;
  @query('mixer-panel') private _mixerPanel!: MixerPanel;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .console {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: var(--space-md, 16px);
      align-items: stretch;
      padding: var(--space-md, 16px);
      height: 100%;
      box-sizing: border-box;
    }

    .console-wrapper {
      position: relative;
      height: 100%;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    // Auto-init audio on first user interaction anywhere on the page
    if (!this._initialized) {
      const handler = () => {
        this._initAudio();
        document.removeEventListener('click', handler);
        document.removeEventListener('keydown', handler);
      };
      document.addEventListener('click', handler, { once: true });
      document.addEventListener('keydown', handler, { once: true });
    }
  }

  render() {
    return html`
      <div class="console-wrapper">
        <div class="console">
          <deck-panel
            id="deck-a"
            deckId="A"
            .trackTitle=${this._trackA?.title ?? ''}
            .trackArtist=${this._trackA?.artist ?? ''}
            .isPlaying=${this._playingA}
            .currentTime=${this._timeA}
            .duration=${this._durationA}
            .bpm=${this._bpmA}
            .peakLevel=${this._peakA}
            @play=${this._onDeckPlay}
            @pause=${this._onDeckPause}
            @cue=${this._onDeckCue}
            @pitch-change=${this._onPitchChange}
          ></deck-panel>

          <mixer-panel
            .peakLevelA=${this._peakA}
            .peakLevelB=${this._peakB}
            .crossfadeValue=${this._crossfade}
            @volume-change=${this._onVolumeChange}
            @eq-change=${this._onEqChange}
            @crossfade-change=${this._onCrossfadeChange}
          ></mixer-panel>

          <deck-panel
            id="deck-b"
            deckId="B"
            .trackTitle=${this._trackB?.title ?? ''}
            .trackArtist=${this._trackB?.artist ?? ''}
            .isPlaying=${this._playingB}
            .currentTime=${this._timeB}
            .duration=${this._durationB}
            .bpm=${this._bpmB}
            .peakLevel=${this._peakB}
            @play=${this._onDeckPlay}
            @pause=${this._onDeckPause}
            @cue=${this._onDeckCue}
            @pitch-change=${this._onPitchChange}
          ></deck-panel>
        </div>
      </div>
    `;
  }

  // ── Initialization ────────────────────────────────────────────────

  private async _initAudio() {
    await audioEngine.init();

    this._playerA = new DeckPlayer('A', {
      onTimeUpdate: (t) => { this._timeA = t; },
      onEnded: () => { this._playingA = false; },
      onLoaded: (d) => { this._durationA = d; },
    });

    this._playerB = new DeckPlayer('B', {
      onTimeUpdate: (t) => { this._timeB = t; },
      onEnded: () => { this._playingB = false; },
      onLoaded: (d) => { this._durationB = d; },
    });

    this._initialized = true;
    this._startAnimationLoop();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._animFrameId);
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Load a track onto a deck.
   * If the track has a url property, it will also load the audio.
   */
  async loadTrack(deck: 'A' | 'B', track: TrackInfo) {
    if (!this._initialized) {
      await this._initAudio();
    }

    if (deck === 'A') {
      // Stop current playback on this deck before loading new track
      if (this._playerA!.isPlaying) this._playerA!.stop();
      this._trackA = track;
      this._bpmA = track.bpm ?? 120;
      if (track.url) {
        await this._playerA!.loadTrack(track.url);
        this._durationA = this._playerA!.duration;
        this._playerA!.play();
        this._playingA = true;
      }
    } else {
      if (this._playerB!.isPlaying) this._playerB!.stop();
      this._trackB = track;
      this._bpmB = track.bpm ?? 120;
      if (track.url) {
        await this._playerB!.loadTrack(track.url);
        this._durationB = this._playerB!.duration;
        this._playerB!.play();
        this._playingB = true;
      }
    }

    this.dispatchEvent(new CustomEvent('track-loaded', {
      detail: { deck, track },
      bubbles: true,
      composed: true,
    }));

    this.dispatchEvent(new CustomEvent('bpm-changed', {
      detail: track.bpm ?? 120,
      bubbles: true,
      composed: true,
    }));
  }

  // ── Animation loop ────────────────────────────────────────────────

  private _startAnimationLoop() {
    const tick = () => {
      this._updateDeckState();
      this._animFrameId = requestAnimationFrame(tick);
    };
    this._animFrameId = requestAnimationFrame(tick);
  }

  private _updateDeckState() {
    // Update times
    if (this._playerA) {
      this._timeA = this._playerA.currentTime;
      this._playingA = this._playerA.isPlaying;
    }
    if (this._playerB) {
      this._timeB = this._playerB.currentTime;
      this._playingB = this._playerB.isPlaying;
    }

    // Update waveform data and peak levels
    const analyzerA = this._playerA?.getWaveformAnalyzer();
    const analyzerB = this._playerB?.getWaveformAnalyzer();

    if (analyzerA) {
      this._peakA = analyzerA.getPeakLevel();
      const waveData = analyzerA.getTimeDomainData();
      this._deckPanelA?.updateWaveform(waveData);
    }

    if (analyzerB) {
      this._peakB = analyzerB.getPeakLevel();
      const waveData = analyzerB.getTimeDomainData();
      this._deckPanelB?.updateWaveform(waveData);
    }
  }

  // ── Event handlers ────────────────────────────────────────────────

  private _getPlayer(deck: 'A' | 'B'): DeckPlayer | null {
    return deck === 'A' ? this._playerA : this._playerB;
  }

  private _onDeckPlay = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    player?.play();
  };

  private _onDeckPause = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    player?.pause();
  };

  private _onDeckCue = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    if (!player) return;

    if (e.detail.action === 'down') {
      // CUE press: seek to cue point (beginning) and play while held
      player.seek(0);
      player.play();
    } else {
      // CUE release: pause and stay at cue point
      player.pause();
      player.seek(0);
    }
  };

  private _onPitchChange = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    player?.setPitch(e.detail.value);

    // Adjust visual BPM based on pitch
    const baseBpm = e.detail.deck === 'A'
      ? (this._trackA?.bpm ?? 120)
      : (this._trackB?.bpm ?? 120);
    const adjustedBpm = baseBpm * e.detail.value;

    if (e.detail.deck === 'A') {
      this._bpmA = adjustedBpm;
    } else {
      this._bpmB = adjustedBpm;
    }

    this.dispatchEvent(new CustomEvent('bpm-changed', {
      detail: adjustedBpm,
      bubbles: true,
      composed: true,
    }));
  };

  private _onVolumeChange = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    player?.setVolume(e.detail.value);
  };

  private _onEqChange = (e: CustomEvent) => {
    const player = this._getPlayer(e.detail.deck);
    const eq = player?.getEQ();
    if (!eq) return;

    const { band, value } = e.detail;
    switch (band) {
      case 'high': eq.setHigh(value); break;
      case 'mid':  eq.setMid(value);  break;
      case 'low':  eq.setLow(value);  break;
    }
  };

  private _onCrossfadeChange = (e: CustomEvent) => {
    this._crossfade = e.detail.value;
    audioEngine.setCrossfade(e.detail.value);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'dj-console': DjConsole;
  }
}
