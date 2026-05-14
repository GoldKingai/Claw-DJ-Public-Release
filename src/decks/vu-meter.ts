import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Vertical VU level meter with segmented green-yellow-red display.
 * Smooth falloff animation.
 */
@customElement('vu-meter')
export class VuMeter extends LitElement {
  @property({ type: Number }) level = 0;

  @state() private _displayLevel = 0;
  @state() private _peakHold = 0;
  private _peakTimer = 0;
  private _animFrameId = 0;
  private _lastTime = 0;

  private static readonly SEGMENTS = 10;
  private static readonly FALLOFF_RATE = 1.5; // units per second
  private static readonly PEAK_HOLD_MS = 800;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
    }

    .meter-container {
      display: flex;
      flex-direction: column-reverse;
      gap: 2px;
      width: 12px;
      height: 100px;
    }

    .segment {
      flex: 1;
      border-radius: 1px;
      background: var(--bg-surface, #0d0d1a);
      border: 1px solid rgba(255, 255, 255, 0.03);
      transition: none;
    }

    .segment.lit-green {
      background: #00ff66;
      box-shadow: 0 0 4px rgba(0, 255, 102, 0.5);
    }

    .segment.lit-yellow {
      background: #ffdd00;
      box-shadow: 0 0 4px rgba(255, 221, 0, 0.5);
    }

    .segment.lit-red {
      background: #ff2244;
      box-shadow: 0 0 6px rgba(255, 34, 68, 0.6);
    }

    .segment.peak {
      border-color: #ffffff;
      opacity: 0.9;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._lastTime = performance.now();
    this._tick();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._animFrameId);
  }

  private _tick = () => {
    const now = performance.now();
    const dt = (now - this._lastTime) / 1000;
    this._lastTime = now;

    // Rise instantly, fall smoothly
    if (this.level >= this._displayLevel) {
      this._displayLevel = this.level;
    } else {
      this._displayLevel = Math.max(0, this._displayLevel - VuMeter.FALLOFF_RATE * dt);
    }

    // Peak hold
    if (this.level >= this._peakHold) {
      this._peakHold = this.level;
      this._peakTimer = now;
    } else if (now - this._peakTimer > VuMeter.PEAK_HOLD_MS) {
      this._peakHold = Math.max(0, this._peakHold - VuMeter.FALLOFF_RATE * dt * 0.5);
    }

    this.requestUpdate();
    this._animFrameId = requestAnimationFrame(this._tick);
  };

  private _segmentColor(index: number): string {
    // index 0 = bottom, SEGMENTS-1 = top
    const total = VuMeter.SEGMENTS;
    if (index < total * 0.6) return 'green';
    if (index < total * 0.85) return 'yellow';
    return 'red';
  }

  render() {
    const segments = VuMeter.SEGMENTS;
    const litCount = Math.round(this._displayLevel * segments);
    const peakSegment = Math.min(segments - 1, Math.round(this._peakHold * (segments - 1)));

    return html`
      <div class="meter-container">
        ${Array.from({ length: segments }, (_, i) => {
          const isLit = i < litCount;
          const isPeak = i === peakSegment && this._peakHold > 0.05;
          const color = this._segmentColor(i);
          let classes = 'segment';
          if (isLit) classes += ` lit-${color}`;
          else if (isPeak) classes += ` lit-${color} peak`;
          return html`<div class=${classes}></div>`;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vu-meter': VuMeter;
  }
}
