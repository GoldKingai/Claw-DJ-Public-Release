import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { NowPlayingTrack } from './now-playing-bar.js';

@customElement('session-stats-panel')
export class SessionStatsPanel extends LitElement {
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
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 16px;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .stat-label {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-value {
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--text-primary);
    }
  `;

  /** Current track passed by flow-app (from server state) */
  @property({ attribute: false }) track: NowPlayingTrack | null = null;
  /** Whether the engine is currently playing */
  @property({ type: Boolean }) isPlaying = false;

  @state() private _tracksPlayed = 0;
  @state() private _sessionTime = '00:00:00';
  @state() private _avgBpm = '—';
  @state() private _genreMix = '—';

  private _clockInterval: number | null = null;
  private _sessionStartTime: number | null = null;
  private _bpmAccum = 0;
  private _bpmCount = 0;
  private _lastTrackTitle: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._clockInterval = window.setInterval(() => this._tickClock(), 1000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._clockInterval) clearInterval(this._clockInterval);
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('track') || changed.has('isPlaying')) {
      this._syncFromProps();
    }
  }

  private _syncFromProps(): void {
    if (this.isPlaying && this._sessionStartTime === null) {
      this._sessionStartTime = Date.now();
    }

    const title = this.track?.title ?? null;
    if (title && title !== this._lastTrackTitle && this.isPlaying) {
      this._lastTrackTitle = title;
      this._tracksPlayed++;

      const bpm = (this.track as any)?.bpm as number | undefined;
      if (bpm && bpm > 0) {
        this._bpmAccum += bpm;
        this._bpmCount++;
        this._avgBpm = (this._bpmAccum / this._bpmCount).toFixed(1);
      }

      const genre = (this.track as any)?.genre as string | undefined;
      if (genre) {
        this._genreMix = genre.split('/')[0].trim() || '—';
      }
    }
  }

  private _tickClock(): void {
    if (this._sessionStartTime === null) return;
    const delta = Math.floor((Date.now() - this._sessionStartTime) / 1000);
    const h = String(Math.floor(delta / 3600)).padStart(2, '0');
    const m = String(Math.floor((delta % 3600) / 60)).padStart(2, '0');
    const s = String(delta % 60).padStart(2, '0');
    this._sessionTime = `${h}:${m}:${s}`;
  }

  override render() {
    return html`
      <div class="section-label">SESSION</div>
      <div class="stats-grid">
        <div class="stat">
          <span class="stat-label">Tracks Played</span>
          <span class="stat-value">${this._tracksPlayed}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Avg BPM</span>
          <span class="stat-value">${this._avgBpm}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Session Time</span>
          <span class="stat-value">${this._sessionStartTime !== null ? this._sessionTime : '—'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Genre Mix</span>
          <span class="stat-value">${this._genreMix}</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-stats-panel': SessionStatsPanel;
  }
}
