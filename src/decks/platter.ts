import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Spinning platter/disc component using CSS animation.
 * Concentric ring groove texture, glowing edge when spinning.
 */
@customElement('deck-platter')
export class DeckPlatter extends LitElement {
  @property({ type: Boolean }) spinning = false;
  @property({ type: Number }) bpm = 120;
  @property({ type: String }) trackLabel = '';

  static styles = css`
    :host {
      display: inline-block;
    }

    .platter-wrap {
      position: relative;
      width: 160px;
      height: 160px;
    }

    .platter {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      position: relative;
      background: radial-gradient(
        circle,
        #111122 0%,
        #0a0a18 20%,
        #111122 21%,
        #0a0a18 35%,
        #111122 36%,
        #0a0a18 50%,
        #111122 51%,
        #0a0a18 65%,
        #111122 66%,
        #0a0a18 80%,
        #111122 81%,
        #0d0d1a 100%
      );
      border: 2px solid var(--holo-border, rgba(0, 255, 255, 0.15));
      box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.5);
      animation: spin var(--spin-duration, 1.8s) linear infinite;
      animation-play-state: paused;
    }

    .platter.spinning {
      animation-play-state: running;
      border-color: var(--neo-cyan, #00ffff);
      box-shadow:
        inset 0 0 20px rgba(0, 0, 0, 0.5),
        0 0 15px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.3),
        0 0 30px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.1);
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .center-label {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: var(--bg-elevated, #1a1a2e);
      border: 2px solid var(--holo-border, rgba(0, 255, 255, 0.15));
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      overflow: hidden;
    }

    .center-label span {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 8px;
      color: var(--text-dim, #556677);
      text-align: center;
      max-width: 40px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      /* Counter-rotate the label so it stays readable */
      animation: counter-spin var(--spin-duration, 1.8s) linear infinite;
      animation-play-state: paused;
    }

    .platter.spinning + .center-label span,
    .spinning ~ .center-label span {
      animation-play-state: running;
    }

    @keyframes counter-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(-360deg); }
    }

    .spindle {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--neo-cyan, #00ffff);
      transform: translate(-50%, -50%);
      pointer-events: none;
      opacity: 0.6;
    }
  `;

  /** Spin duration in seconds, derived from BPM. Base 33.33 RPM adjusted by BPM ratio. */
  private get _spinDuration(): number {
    // 33.33 RPM = 1.8 seconds per revolution
    // Adjust proportionally: faster BPM = faster spin
    const baseBpm = 120;
    const baseSeconds = 1.8;
    return baseSeconds * (baseBpm / Math.max(60, this.bpm));
  }

  render() {
    const duration = this._spinDuration;
    return html`
      <div class="platter-wrap" style="--spin-duration: ${duration}s">
        <div class="platter ${this.spinning ? 'spinning' : ''}"></div>
        <div class="center-label">
          <span class="${this.spinning ? 'counter-spinning' : ''}"
                style="animation-play-state: ${this.spinning ? 'running' : 'paused'}"
          >${this.trackLabel || '\u25CF'}</span>
        </div>
        <div class="spindle"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'deck-platter': DeckPlatter;
  }
}
