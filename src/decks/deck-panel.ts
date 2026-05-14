import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import './platter.js';
import './waveform-display.js';
import './transport-controls.js';
import './fader.js';

/**
 * Single deck panel — used twice (Deck A and Deck B).
 * Contains platter, waveform, transport controls, track info, time display, pitch fader.
 */
@customElement('deck-panel')
export class DeckPanel extends LitElement {
  @property({ type: String }) deckId: 'A' | 'B' = 'A';
  @property({ type: String }) trackTitle = '';
  @property({ type: String }) trackArtist = '';
  @property({ type: Boolean }) isPlaying = false;
  @property({ type: Number }) currentTime = 0;
  @property({ type: Number }) duration = 0;
  @property({ type: Number }) bpm = 120;
  @property({ type: Number }) peakLevel = 0;

  /** Externally-set waveform data buffer. */
  waveformData: Float32Array | null = null;

  @query('waveform-display') private _waveformDisplay: any;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .deck-panel {
      background: rgba(5, 10, 22, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(0, 240, 255, 0.12);
      border-radius: var(--radius-lg, 16px);
      padding: var(--space-md, 16px);
      display: flex;
      flex-direction: column;
      gap: var(--space-sm, 8px);
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
      box-shadow:
        0 0 20px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.05),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }

    .deck-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: var(--space-xs, 4px);
      border-bottom: 1px solid rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.08);
    }

    .deck-label {
      font-family: var(--font-display, 'Orbitron', sans-serif);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--neo-cyan, #00ffff);
      text-shadow: 0 0 8px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.5);
    }

    .bpm-display {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 13px;
      color: var(--neo-magenta, #ff00ff);
      text-shadow: 0 0 6px rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.4);
    }

    .track-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 32px;
    }

    .track-title {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #eeeeff);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .track-artist {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 11px;
      color: var(--text-secondary, #8899aa);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .visual-section {
      display: flex;
      gap: var(--space-md, 16px);
      align-items: center;
    }

    .waveform-wrapper {
      flex: 1;
      min-width: 0;
    }

    .time-display {
      display: flex;
      justify-content: space-between;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 20px;
      color: var(--text-primary, #eeeeff);
      letter-spacing: 1px;
      padding: var(--space-xs, 4px) 0;
    }

    .time-elapsed {
      color: var(--neo-cyan, #00ffff);
    }

    .time-remaining {
      color: var(--text-dim, #556677);
    }

    .controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm, 8px);
    }

    .pitch-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-xs, 4px);
    }

    .pitch-label {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 10px;
      color: var(--text-secondary, #8899aa);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  `;

  private _formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  render() {
    const remaining = Math.max(0, this.duration - this.currentTime);
    const progress = this.duration > 0 ? this.currentTime / this.duration : 0;

    return html`
      <div class="deck-panel">
        <div class="deck-header">
          <span class="deck-label">DECK ${this.deckId}</span>
          <span class="bpm-display">${this.bpm.toFixed(1)} BPM</span>
        </div>

        <div class="track-info">
          <span class="track-title">${this.trackTitle || 'No Track Loaded'}</span>
          <span class="track-artist">${this.trackArtist || '\u2014'}</span>
        </div>

        <div class="visual-section">
          <deck-platter
            ?spinning=${this.isPlaying}
            .bpm=${this.bpm}
            .trackLabel=${this.trackTitle ? this.trackTitle.substring(0, 8) : ''}
          ></deck-platter>
          <div class="waveform-wrapper">
            <waveform-display
              .width=${300}
              .height=${80}
              .progress=${progress}
            ></waveform-display>
          </div>
        </div>

        <div class="time-display">
          <span class="time-elapsed">${this._formatTime(this.currentTime)}</span>
          <span class="time-remaining">-${this._formatTime(remaining)}</span>
        </div>

        <div class="controls-row">
          <transport-controls
            .isPlaying=${this.isPlaying}
            @transport-play=${this._onPlay}
            @transport-pause=${this._onPause}
            @transport-cue=${this._onCue}
          ></transport-controls>

          <div class="pitch-section">
            <span class="pitch-label">PITCH</span>
            <dj-fader
              orientation="vertical"
              .value=${0.5}
              @fader-change=${this._onPitchChange}
            ></dj-fader>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Called by parent on each animation frame to push waveform data to the canvas.
   */
  updateWaveform(data: Float32Array | null) {
    const display = this._waveformDisplay;
    if (display) {
      display.data = data;
      display.progress = this.duration > 0 ? this.currentTime / this.duration : 0;
      display.renderWaveform();
    }
  }

  private _onPlay = () => {
    this.dispatchEvent(new CustomEvent('play', {
      detail: { deck: this.deckId },
      bubbles: true,
      composed: true,
    }));
  };

  private _onPause = () => {
    this.dispatchEvent(new CustomEvent('pause', {
      detail: { deck: this.deckId },
      bubbles: true,
      composed: true,
    }));
  };

  private _onCue = (e: CustomEvent) => {
    this.dispatchEvent(new CustomEvent('cue', {
      detail: { deck: this.deckId, action: e.detail?.action },
      bubbles: true,
      composed: true,
    }));
  };

  private _onPitchChange = (e: CustomEvent) => {
    // Fader value 0-1 → pitch range 0.92 to 1.08 (±8%)
    const faderValue = e.detail.value;
    const pitch = 0.92 + faderValue * 0.16;
    this.dispatchEvent(new CustomEvent('pitch-change', {
      detail: { deck: this.deckId, value: pitch },
      bubbles: true,
      composed: true,
    }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'deck-panel': DeckPanel;
  }
}
