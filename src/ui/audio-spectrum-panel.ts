import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

const BAR_COUNT = 32;
const TARGET_FPS = 30;

@customElement('audio-spectrum-panel')
export class AudioSpectrumPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 12px;
    }

    .section-label {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    canvas {
      display: block;
      width: 100%;
      height: 80px;
      border-radius: 3px;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .meta-label {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .meta-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
    }

    .energy-bar {
      height: 3px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 2px;
      margin-top: 6px;
      overflow: hidden;
    }

    .energy-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.15s linear;
    }
  `;

  @property({ type: Number }) bpm = 0;
  @property({ type: Boolean }) isPlaying = false;

  @state() private _energy = 0;

  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _rafId = 0;
  private _bars: number[] = new Array(BAR_COUNT).fill(0);
  private _peaks: number[] = new Array(BAR_COUNT).fill(0);
  private _lastTime = 0;

  override firstUpdated(): void {
    this._canvas = this.shadowRoot!.querySelector('canvas')!;
    this._canvas.width = 256;
    this._canvas.height = 80;
    this._ctx = this._canvas.getContext('2d')!;
    this._startLoop();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  private _startLoop(): void {
    const loop = (time: number) => {
      this._rafId = requestAnimationFrame(loop);
      if (time - this._lastTime < 1000 / TARGET_FPS) return;
      this._lastTime = time;
      this._updateBars();
      this._draw();
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _updateBars(): void {
    const bpm = this.bpm > 0 ? this.bpm : 120;
    const beatMs = 60000 / bpm;
    const beatPhase = (performance.now() % beatMs) / beatMs; // 0–1 within beat
    // Sharp transient at beat start, decays over first 20% of beat
    const beatHit = beatPhase < 0.2 ? Math.pow(1 - beatPhase / 0.2, 1.8) : 0;

    let totalEnergy = 0;

    for (let i = 0; i < BAR_COUNT; i++) {
      const norm = i / BAR_COUNT; // 0 = bass, 1 = treble
      let target: number;

      if (!this.isPlaying) {
        // Idle: nearly flat, tiny movement
        target = 0.02 + Math.random() * 0.04 * (1 - norm * 0.5);
      } else if (norm < 0.15) {
        // Bass: hard kick on the beat
        target = 0.35 + beatHit * 0.60 + Math.random() * 0.08;
      } else if (norm < 0.35) {
        // Low-mid: moderate beat + groove
        target = 0.22 + beatHit * 0.35 + Math.random() * 0.18;
      } else if (norm < 0.60) {
        // Mid: less beat response, continuous movement
        target = 0.14 + beatHit * 0.15 + Math.random() * 0.22;
      } else {
        // Highs: rapid small flicker, minimal beat
        target = 0.04 + Math.random() * 0.20 + beatHit * 0.06;
      }

      const lerpSpeed = this.isPlaying ? 0.38 : 0.07;
      this._bars[i] += (target - this._bars[i]) * lerpSpeed;
      totalEnergy += this._bars[i];
    }

    this._energy = totalEnergy / BAR_COUNT;

    // Peak hold with slow decay
    for (let i = 0; i < BAR_COUNT; i++) {
      if (this._bars[i] > this._peaks[i]) {
        this._peaks[i] = this._bars[i];
      } else {
        this._peaks[i] *= 0.97;
      }
    }
  }

  private _draw(): void {
    const ctx = this._ctx!;
    const w = 256;
    const h = 80;
    ctx.clearRect(0, 0, w, h);

    const barW = (w - BAR_COUNT + 1) / BAR_COUNT;
    const gap = 1;

    for (let i = 0; i < BAR_COUNT; i++) {
      const val = this._bars[i];
      const barH = Math.max(1, val * (h - 4));
      const x = i * (barW + gap);
      const y = h - barH - 2;

      // DJ meter colors: green → yellow → red
      if (val > 0.75) {
        ctx.fillStyle = `rgba(255, 50, 50, ${0.6 + val * 0.4})`;
      } else if (val > 0.45) {
        ctx.fillStyle = `rgba(255, 200, 0, ${0.5 + val * 0.4})`;
      } else {
        ctx.fillStyle = `rgba(0, 220, 80, ${0.4 + val * 0.5})`;
      }

      ctx.fillRect(x, y, barW, barH);

      // Peak hold line
      if (this._peaks[i] > 0.05) {
        const peakY = h - this._peaks[i] * (h - 4) - 2;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fillRect(x, peakY, barW, 1);
      }
    }
  }

  override render() {
    const energyPct = Math.round(this._energy * 100);
    let energyColor = 'rgba(0, 220, 80, 0.7)';
    if (this._energy > 0.7) energyColor = 'rgba(255, 50, 50, 0.8)';
    else if (this._energy > 0.4) energyColor = 'rgba(255, 200, 0, 0.7)';

    return html`
      <div class="section-label">AUDIO ANALYSIS</div>
      <canvas></canvas>
      <div class="meta-row">
        <div class="meta-item">
          <span class="meta-label">BPM</span>
          <span class="meta-value">${this.bpm > 0 ? this.bpm : '—'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Energy</span>
          <span class="meta-value">${energyPct}%</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Status</span>
          <span class="meta-value">${this.isPlaying ? 'LIVE' : 'IDLE'}</span>
        </div>
      </div>
      <div class="energy-bar">
        <div class="energy-fill" style="width: ${energyPct}%; background: ${energyColor}"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'audio-spectrum-panel': AudioSpectrumPanel;
  }
}
