import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Transport control buttons: CUE, PLAY/PAUSE, SYNC.
 * Glowing buttons with NeoFlux 2050 styling.
 */
@customElement('transport-controls')
export class TransportControls extends LitElement {
  @property({ type: Boolean }) isPlaying = false;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-sm, 8px);
    }

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 8px 14px;
      min-width: 48px;
      transition: all var(--transition-fast, 0.15s) var(--ease-out-expo, ease-out);
      position: relative;
      overflow: hidden;
    }

    button::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      opacity: 0;
      transition: opacity var(--transition-fast, 0.15s);
    }

    button:hover::before {
      opacity: 1;
    }

    button:active {
      transform: scale(0.95);
    }

    .btn-cue {
      background: rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.15);
      color: var(--neo-magenta, #ff00ff);
      border: 1px solid rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.3);
    }

    .btn-cue:hover {
      background: rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.25);
      box-shadow: 0 0 12px rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.3);
    }

    .btn-cue:active,
    .btn-cue.active {
      background: rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.4);
      box-shadow: 0 0 18px rgba(var(--neo-magenta-rgb, 255, 0, 255), 0.5);
    }

    .btn-play {
      background: rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.15);
      color: var(--neo-cyan, #00ffff);
      border: 1px solid rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.3);
      min-width: 56px;
    }

    .btn-play:hover {
      background: rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.25);
      box-shadow: 0 0 12px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.3);
    }

    .btn-play.playing {
      background: rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.35);
      box-shadow: 0 0 18px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.5);
    }

    .btn-sync {
      background: rgba(var(--neo-violet, 136, 0, 255), 0.15);
      color: var(--neo-violet, #8800ff);
      border: 1px solid rgba(136, 0, 255, 0.3);
      font-size: 10px;
      padding: 6px 10px;
      min-width: 40px;
    }

    .btn-sync:hover {
      background: rgba(136, 0, 255, 0.25);
      box-shadow: 0 0 12px rgba(136, 0, 255, 0.3);
    }

    .play-icon {
      font-size: 14px;
      line-height: 1;
    }
  `;

  render() {
    return html`
      <button
        class="btn-cue"
        @mousedown=${this._onCueDown}
        @mouseup=${this._onCueUp}
        @mouseleave=${this._onCueUp}
      >CUE</button>
      <button
        class="btn-play ${this.isPlaying ? 'playing' : ''}"
        @click=${this._onPlayPause}
      >
        <span class="play-icon">${this.isPlaying ? '\u23F8' : '\u25B6'}</span>
      </button>
      <button
        class="btn-sync"
        @click=${this._onSync}
      >SYNC</button>
    `;
  }

  private _onPlayPause = () => {
    if (this.isPlaying) {
      this.dispatchEvent(new CustomEvent('transport-pause', { bubbles: true, composed: true }));
    } else {
      this.dispatchEvent(new CustomEvent('transport-play', { bubbles: true, composed: true }));
    }
  };

  private _onCueDown = () => {
    this.dispatchEvent(new CustomEvent('transport-cue', {
      detail: { action: 'down' },
      bubbles: true,
      composed: true,
    }));
  };

  private _onCueUp = () => {
    this.dispatchEvent(new CustomEvent('transport-cue', {
      detail: { action: 'up' },
      bubbles: true,
      composed: true,
    }));
  };

  private _onSync = () => {
    this.dispatchEvent(new CustomEvent('transport-sync', { bubbles: true, composed: true }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'transport-controls': TransportControls;
  }
}
