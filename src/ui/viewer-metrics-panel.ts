import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface MetricsSnapshot {
  viewers: number;
  peakViewers: number;
  subscribers: number;
  likes: number;
  updatedAt: number;
}

@customElement('viewer-metrics-panel')
export class ViewerMetricsPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 12px;
    }

    .header {
      display: flex;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .section-label {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    .big-stats {
      display: flex;
      gap: 16px;
      margin-bottom: 12px;
    }

    .big-stat {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .big-stat-label {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .big-stat-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .big-stat-value {
      font-family: var(--font-display);
      font-size: 22px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: 0.5px;
    }

    .viewer-trend {
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .trend-up { color: var(--neo-lime); }
    .trend-down { color: var(--neo-magenta); }

    .sub-count {
      color: var(--neo-cyan);
    }

    .micro-stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 6px;
    }

    .micro-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .micro-label {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .micro-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
    }
  `;

  @state() private _viewers = 1247;
  @state() private _peakViewers = 2891;
  @state() private _subscribers = 14820;
  @state() private _likes = 487;
  @state() private _trend = 0;
  @state() private _isLive = false; // true when SSE is receiving real data

  private _pollInterval: number | null = null;
  private _mockInterval: number | null = null;
  private _prevViewers = 1247;

  override connectedCallback(): void {
    super.connectedCallback();
    this._startPolling();
    this._startMock(); // always runs as background animation; stops when polling delivers real data
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._mockInterval) clearInterval(this._mockInterval);
  }

  private _startPolling(): void {
    // Poll every 5 s instead of SSE to avoid consuming a persistent HTTP/1.1 connection slot.
    const poll = async () => {
      try {
        const res = await fetch('/api/metrics/status');
        if (!res.ok) return;
        const body = await res.json() as { snapshot: MetricsSnapshot };
        const d = body.snapshot;
        if (!d || d.updatedAt === 0) return; // service not yet configured
        this._prevViewers = this._viewers;
        this._viewers = d.viewers;
        this._peakViewers = d.peakViewers;
        this._subscribers = d.subscribers;
        this._likes = d.likes;
        this._isLive = true;
        if (this._prevViewers > 0) {
          this._trend = Math.round(
            ((this._viewers - this._prevViewers) / this._prevViewers) * 100
          );
        }
      } catch { /* network error — retry next interval */ }
    };
    void poll(); // immediate first fetch
    this._pollInterval = window.setInterval(poll, 5_000);
  }

  private _startMock(): void {
    this._mockInterval = window.setInterval(() => {
      if (this._isLive) return; // real data flowing — keep mock frozen
      this._prevViewers = this._viewers;
      const change = Math.floor(Math.random() * 8) - 3;
      this._viewers = Math.max(800, this._viewers + change);
      this._peakViewers = Math.max(this._peakViewers, this._viewers);
      if (Math.random() < 0.08) this._subscribers += 1;
      if (Math.random() < 0.15) this._likes += Math.floor(Math.random() * 3);
      if (this._prevViewers > 0) {
        this._trend = Math.round(
          ((this._viewers - this._prevViewers) / this._prevViewers) * 100
        );
      }
    }, 3000);
  }

  private _fmt(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  }

  override render() {
    const isUp = this._trend >= 0;
    return html`
      <div class="header">
        <span class="section-label">STREAM</span>
      </div>

      <div class="big-stats">
        <div class="big-stat">
          <span class="big-stat-label">Viewers</span>
          <div class="big-stat-row">
            <span class="big-stat-value">${this._fmt(this._viewers)}</span>
            <span class="viewer-trend ${isUp ? 'trend-up' : 'trend-down'}">
              ${isUp ? '▲' : '▼'}${Math.abs(this._trend)}%
            </span>
          </div>
        </div>
      </div>

      <div class="micro-stats">
        <div class="micro-stat">
          <span class="micro-label">Peak</span>
          <span class="micro-value">${this._fmt(this._peakViewers)}</span>
        </div>
        <div class="micro-stat">
          <span class="micro-label">Source</span>
          <span class="micro-value" style="color: ${this._isLive ? 'var(--neo-lime)' : 'var(--text-dim)'}">
            ${this._isLive ? 'LIVE' : 'DEMO'}
          </span>
        </div>
        <div class="micro-stat">
          <span class="micro-label">Subs</span>
          <span class="micro-value sub-count">${this._fmt(this._subscribers)}</span>
        </div>
        <div class="micro-stat">
          <span class="micro-label">Likes</span>
          <span class="micro-value">${this._fmt(this._likes)}</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'viewer-metrics-panel': ViewerMetricsPanel;
  }
}
