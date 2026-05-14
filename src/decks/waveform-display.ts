import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

/**
 * Canvas-based scrolling waveform visualization.
 * Cyan-to-magenta gradient with a playhead indicator.
 */
@customElement('waveform-display')
export class WaveformDisplay extends LitElement {
  @property({ type: Number }) width = 300;
  @property({ type: Number }) height = 80;
  @property({ type: Number }) progress = 0; // 0-1

  /** Waveform sample data (-1 to 1). Set externally each frame. */
  data: Float32Array | null = null;

  @query('canvas') private _canvas!: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _gradient: CanvasGradient | null = null;

  static styles = css`
    :host {
      display: block;
      border-radius: var(--radius-sm, 4px);
      overflow: hidden;
      border: 1px solid var(--holo-border, rgba(0, 255, 255, 0.15));
      background: var(--bg-void, #050510);
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  render() {
    return html`
      <canvas width=${this.width} height=${this.height}></canvas>
    `;
  }

  firstUpdated() {
    const canvas = this._canvas;
    if (canvas) {
      this._ctx = canvas.getContext('2d');
      this._createGradient();
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('width') || changed.has('height')) {
      this._createGradient();
    }
  }

  private _createGradient() {
    if (!this._ctx) return;
    this._gradient = this._ctx.createLinearGradient(0, 0, this.width, 0);
    this._gradient.addColorStop(0, '#00ffff');
    this._gradient.addColorStop(0.5, '#8844ff');
    this._gradient.addColorStop(1, '#ff00ff');
  }

  /**
   * Call this on each animation frame to redraw the waveform.
   */
  renderWaveform() {
    const ctx = this._ctx;
    if (!ctx) return;

    const w = this.width;
    const h = this.height;
    const midY = h / 2;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background grid lines (subtle)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Draw waveform
    if (this.data && this.data.length > 0) {
      const data = this.data;
      const step = data.length / w;

      ctx.fillStyle = this._gradient || '#00ffff';

      for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const sample = Math.abs(data[idx] || 0);
        const barHeight = sample * midY * 0.9;

        // Mirror bar around center
        ctx.globalAlpha = x / w < this.progress ? 0.9 : 0.35;
        ctx.fillRect(x, midY - barHeight, 1, barHeight * 2);
      }

      ctx.globalAlpha = 1;
    }

    // Playhead
    if (this.progress > 0 && this.progress <= 1) {
      const px = Math.round(this.progress * w);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'waveform-display': WaveformDisplay;
  }
}
