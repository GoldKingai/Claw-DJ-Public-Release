import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Vertical or horizontal slider fader with drag interaction.
 * Value range: 0-1.
 */
@customElement('dj-fader')
export class DjFader extends LitElement {
  @property({ type: String }) orientation: 'vertical' | 'horizontal' = 'vertical';
  @property({ type: Number }) value = 0.75;
  @property({ type: String }) label = '';

  @state() private _dragging = false;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-xs, 4px);
      user-select: none;
      -webkit-user-select: none;
    }

    .fader-label {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 10px;
      color: var(--text-secondary, #8899aa);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .track-container {
      position: relative;
      cursor: pointer;
    }

    :host([orientation="vertical"]) .track-container,
    .track-container.vertical {
      width: 24px;
      height: 120px;
    }

    .track-container.horizontal {
      width: 200px;
      height: 24px;
    }

    .track {
      position: absolute;
      background: var(--bg-surface, #0d0d1a);
      border: 1px solid var(--holo-border, rgba(0, 255, 255, 0.15));
      border-radius: var(--radius-sm, 4px);
    }

    .track-container.vertical .track {
      left: 50%;
      top: 0;
      bottom: 0;
      width: 4px;
      transform: translateX(-50%);
    }

    .track-container.horizontal .track {
      top: 50%;
      left: 0;
      right: 0;
      height: 4px;
      transform: translateY(-50%);
    }

    .track-fill {
      position: absolute;
      background: linear-gradient(
        to top,
        var(--neo-cyan, #00ffff),
        var(--neo-magenta, #ff00ff)
      );
      border-radius: var(--radius-sm, 4px);
      opacity: 0.6;
    }

    .track-container.vertical .track-fill {
      left: 50%;
      bottom: 0;
      width: 4px;
      transform: translateX(-50%);
    }

    .track-container.horizontal .track-fill {
      top: 50%;
      left: 0;
      height: 4px;
      transform: translateY(-50%);
    }

    .thumb {
      position: absolute;
      background: var(--bg-elevated, #1a1a2e);
      border: 2px solid var(--neo-cyan, #00ffff);
      border-radius: var(--radius-sm, 4px);
      box-shadow: 0 0 8px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.4);
      transition: box-shadow var(--transition-fast, 0.15s);
      z-index: 1;
    }

    .thumb:hover,
    .thumb.dragging {
      box-shadow: 0 0 14px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.7);
    }

    .track-container.vertical .thumb {
      width: 22px;
      height: 10px;
      left: 50%;
      transform: translateX(-50%) translateY(50%);
    }

    .track-container.horizontal .thumb {
      width: 10px;
      height: 22px;
      top: 50%;
      transform: translateY(-50%) translateX(-50%);
    }
  `;

  render() {
    const isVertical = this.orientation === 'vertical';
    const thumbStyle = isVertical
      ? `bottom: ${this.value * 100}%`
      : `left: ${this.value * 100}%`;
    const fillStyle = isVertical
      ? `height: ${this.value * 100}%`
      : `width: ${this.value * 100}%`;

    return html`
      ${this.label ? html`<span class="fader-label">${this.label}</span>` : ''}
      <div
        class="track-container ${this.orientation}"
        @mousedown=${this._onMouseDown}
      >
        <div class="track"></div>
        <div class="track-fill" style=${fillStyle}></div>
        <div class="thumb ${this._dragging ? 'dragging' : ''}" style=${thumbStyle}></div>
      </div>
    `;
  }

  private _onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    this._dragging = true;
    this._updateFromMouse(e);

    const onMove = (ev: MouseEvent) => {
      if (!this._dragging) return;
      this._updateFromMouse(ev);
    };

    const onUp = () => {
      this._dragging = false;
      this.requestUpdate();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  private _updateFromMouse(e: MouseEvent) {
    const container = this.shadowRoot!.querySelector('.track-container') as HTMLElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    let newValue: number;
    if (this.orientation === 'vertical') {
      newValue = 1 - (e.clientY - rect.top) / rect.height;
    } else {
      newValue = (e.clientX - rect.left) / rect.width;
    }

    this.value = Math.max(0, Math.min(1, newValue));
    this._fireChange();
  }

  private _fireChange() {
    this.dispatchEvent(
      new CustomEvent('fader-change', {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dj-fader': DjFader;
  }
}
