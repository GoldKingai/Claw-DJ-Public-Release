import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Rotary EQ knob with drag-to-rotate interaction.
 * Range: -24 to +24 dB, default 0. Double-click resets to center.
 */
@customElement('eq-knob')
export class EqKnob extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = -24;
  @property({ type: Number }) max = 24;

  @state() private _dragging = false;
  private _dragStartY = 0;
  private _dragStartValue = 0;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-xs, 4px);
      user-select: none;
      -webkit-user-select: none;
    }

    .knob-container {
      position: relative;
      width: 40px;
      height: 40px;
      cursor: grab;
    }

    .knob-container:active {
      cursor: grabbing;
    }

    .knob-ring {
      position: absolute;
      inset: 0;
      border-radius: var(--radius-round, 50%);
      border: 2px solid var(--holo-border, rgba(0, 255, 255, 0.15));
      background: var(--bg-elevated, #1a1a2e);
      transition: box-shadow var(--transition-fast, 0.15s);
    }

    :host([active]) .knob-ring,
    .knob-ring.active {
      box-shadow: 0 0 8px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.4);
      border-color: var(--neo-cyan, #00ffff);
    }

    .knob-indicator {
      position: absolute;
      top: 4px;
      left: 50%;
      width: 2px;
      height: 12px;
      background: var(--neo-cyan, #00ffff);
      border-radius: 1px;
      transform-origin: bottom center;
      transform: translateX(-50%);
      pointer-events: none;
    }

    .knob-inner {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: rotate(var(--knob-rotation, 0deg));
    }

    .label {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 10px;
      color: var(--text-secondary, #8899aa);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      text-align: center;
      line-height: 1;
    }

    .value-display {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9px;
      color: var(--text-dim, #556677);
      text-align: center;
      line-height: 1;
    }
  `;

  private get _rotation(): number {
    // Map value range to -135deg .. +135deg
    const range = this.max - this.min;
    if (range === 0) return 0;
    const normalized = (this.value - this.min) / range; // 0..1
    return -135 + normalized * 270;
  }

  private get _isNonZero(): boolean {
    return Math.abs(this.value) > 0.5;
  }

  render() {
    const rotation = this._rotation;
    return html`
      <div
        class="knob-container"
        @mousedown=${this._onMouseDown}
        @dblclick=${this._onDoubleClick}
      >
        <div class="knob-ring ${this._isNonZero ? 'active' : ''}"></div>
        <div class="knob-inner" style="--knob-rotation: ${rotation}deg; transform: rotate(${rotation}deg);">
          <div class="knob-indicator"></div>
        </div>
      </div>
      <span class="label">${this.label}</span>
      <span class="value-display">${this.value > 0 ? '+' : ''}${this.value.toFixed(0)}</span>
    `;
  }

  private _onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    this._dragging = true;
    this._dragStartY = e.clientY;
    this._dragStartValue = this.value;

    const onMove = (ev: MouseEvent) => {
      if (!this._dragging) return;
      const deltaY = this._dragStartY - ev.clientY;
      const sensitivity = (this.max - this.min) / 150; // full range over 150px drag
      const newValue = this._dragStartValue + deltaY * sensitivity;
      this.value = Math.round(Math.max(this.min, Math.min(this.max, newValue)));
      this._fireChange();
    };

    const onUp = () => {
      this._dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  private _onDoubleClick = () => {
    this.value = 0;
    this._fireChange();
  };

  private _fireChange() {
    this.dispatchEvent(
      new CustomEvent('knob-change', {
        detail: { value: this.value, label: this.label },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eq-knob': EqKnob;
  }
}
