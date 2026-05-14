import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export interface NowPlayingTrack {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  // Extended fields from server (optional — cast to any to access)
  bpm?: number;
  genre?: string;
  key?: string;
}

@customElement('now-playing-bar')
export class NowPlayingBar extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: var(--now-playing-h, 72px);
      font-family: var(--font-body);
    }

    .bar {
      display: flex;
      align-items: center;
      height: 100%;
      background: var(--bg-surface);
      border-top: 1px solid var(--panel-border);
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
      padding: 0;
    }

    /* ── Progress bar (full width at top) ── */
    .progress-track {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: rgba(255, 255, 255, 0.06);
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--neo-cyan, #00f0ff), #a855f7);
      box-shadow: 0 0 6px rgba(0, 240, 255, 0.5);
      transition: width 0.5s linear;
      width: 0%;
    }

    /* ── Three-section layout ── */
    .section-left {
      flex: 0 0 140px;
      padding: 0 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      border-right: 1px solid var(--panel-border);
      height: 100%;
      box-sizing: border-box;
    }

    .section-center {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 0 20px;
      height: 100%;
      position: relative;
      min-width: 0;
    }

    .section-right {
      flex: 0 0 200px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      justify-content: flex-end;
      border-left: 1px solid var(--panel-border);
      height: 100%;
      box-sizing: border-box;
    }

    /* ── BPM display (left) ── */
    .bpm-value {
      font-family: var(--font-mono);
      font-size: 22px;
      font-weight: 700;
      color: var(--neo-cyan, #00f0ff);
      line-height: 1;
    }

    .bpm-label {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    /* ── Center: song title + artist ── */
    .title-container {
      width: 100%;
      text-align: center;
      overflow: hidden;
    }

    .track-title {
      display: block;
      font-family: var(--font-body);
      font-size: 22px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      background: linear-gradient(90deg, #00f0ff 0%, #c084fc 50%, #ff00ff 100%);
      background-size: 200% auto;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: titleGradient 4s linear infinite;
    }

    @keyframes titleGradient {
      0%   { background-position: 0% center; }
      100% { background-position: 200% center; }
    }

    .track-artist {
      display: block;
      margin-top: 2px;
      font-family: var(--font-body);
      font-size: 12px;
      color: var(--text-secondary, rgba(255,255,255,0.7));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.5px;
    }

    /* ── Waveform / progress mini canvas ── */
    canvas {
      display: block;
      margin-top: 4px;
      width: 100%;
      height: 12px;
      opacity: 0.6;
    }

    /* ── Metadata (right) ── */
    .meta-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1px;
    }

    .meta-value {
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--text-primary);
    }

    .meta-label {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .genre-pill {
      font-family: var(--font-body);
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      padding: 2px 7px;
      border-radius: 3px;
      border: 1px solid var(--panel-border);
      text-transform: uppercase;
      letter-spacing: 1px;
      white-space: nowrap;
    }

    /* ── Empty state ── */
    .empty {
      font-family: var(--font-body);
      font-size: 12px;
      color: var(--text-dim);
      letter-spacing: 1px;
      text-transform: uppercase;
      user-select: none;
      padding: 0 16px;
    }
  `;

  @property({ type: Object }) track: NowPlayingTrack | null = null;
  @property({ type: Number }) bpm = 0;
  @property({ type: Number }) progress = 0;

  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _rafId = 0;
  private _waveData: number[] = [];
  private _lastTime = 0;

  override firstUpdated(): void {
    this._canvas = this.shadowRoot!.querySelector('canvas');
    if (this._canvas) {
      this._canvas.width = 600;
      this._canvas.height = 12;
      this._ctx = this._canvas.getContext('2d')!;
      this._waveData = Array.from({ length: 200 }, () => Math.random() * 0.5 + 0.1);
      this._startLoop();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  private _startLoop(): void {
    const loop = (time: number) => {
      this._rafId = requestAnimationFrame(loop);
      if (time - this._lastTime < 50) return; // ~20fps
      this._lastTime = time;
      this._drawWaveform();
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _drawWaveform(): void {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const w = 600;
    const h = 12;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Subtle center line
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, mid, w, 1);

    const barW = 2;
    const gap = 1;
    const count = Math.floor(w / (barW + gap));

    if (this._waveData.length > 0) {
      this._waveData.push(Math.random() * 0.5 + 0.1);
      this._waveData.shift();
    }

    for (let i = 0; i < count && i < this._waveData.length; i++) {
      const val = this._waveData[i];
      const barH = val * (h - 2);
      const x = i * (barW + gap);
      const progressX = this.progress / 100 * w;
      const opacity = x < progressX ? 0.55 : 0.18;
      ctx.fillStyle = `rgba(168, 85, 247, ${opacity})`;
      ctx.fillRect(x, mid - barH / 2, barW, barH);
    }

    // Playhead
    const phX = this.progress / 100 * w;
    ctx.fillStyle = 'rgba(0, 240, 255, 0.9)';
    ctx.fillRect(phX - 0.5, 0, 1, h);
  }

  private _formatRemaining(): string {
    if (!this.track || this.track.duration <= 0) return '';
    const rem = Math.max(0, this.track.duration * (1 - this.progress / 100));
    const m = Math.floor(rem / 60);
    const s = Math.floor(rem % 60);
    return `-${m}:${String(s).padStart(2, '0')}`;
  }

  render() {
    const progressPct = Math.min(100, Math.max(0, this.progress));
    const genre = (this.track as any)?.genre as string | undefined;

    if (!this.track) {
      return html`
        <div class="bar">
          <div class="progress-track">
            <div class="progress-fill" style="width: ${progressPct}%"></div>
          </div>
          <span class="empty">No Track Loaded</span>
        </div>
      `;
    }

    return html`
      <div class="bar">
        <div class="progress-track">
          <div class="progress-fill" style="width: ${progressPct}%"></div>
        </div>

        <div class="section-left">
          ${this.bpm > 0
            ? html`
                <span class="bpm-value">${this.bpm.toFixed(0)}</span>
                <span class="bpm-label">BPM</span>
              `
            : nothing}
        </div>

        <div class="section-center">
          <div class="title-container">
            <span class="track-title">${this.track.title}</span>
            <span class="track-artist">${this.track.artist}</span>
          </div>
          <canvas></canvas>
        </div>

        <div class="section-right">
          ${genre ? html`<span class="genre-pill">${genre}</span>` : nothing}
          <div class="meta-group">
            <span class="meta-value">${this._formatRemaining()}</span>
            <span class="meta-label">Remain</span>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'now-playing-bar': NowPlayingBar;
  }
}
