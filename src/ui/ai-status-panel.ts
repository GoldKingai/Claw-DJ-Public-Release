import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { aiDjService, type DJState } from '../services/ai-dj-service.js';
import audioEngine from '../playback/audio-engine.js';

const STATE_DISPLAY: Record<DJState, { label: string; color: string }> = {
  IDLE:       { label: 'STANDBY',    color: 'rgba(255,255,255,0.35)' },
  LOADING:    { label: 'LOADING',    color: '#ffaa00' },
  PLAYING:    { label: 'MIXING',     color: '#00ff66' },
  CROSSFADING:{ label: 'CROSSFADE',  color: '#00f0ff' },
};

@customElement('ai-status-panel')
export class AiStatusPanel extends LitElement {
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

    .state-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .state-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      animation: state-pulse 2s ease-in-out infinite;
    }

    @keyframes state-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .state-label {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 1.5px;
    }

    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .info-label {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .info-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
    }

    .processing-bar {
      height: 2px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 1px;
      overflow: hidden;
      margin-top: 10px;
    }

    .processing-fill {
      height: 100%;
      width: 40%;
      background: linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.4), transparent);
      animation: processing-sweep 2.5s ease-in-out infinite;
    }

    @keyframes processing-sweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(350%); }
    }
  `;

  @state() private _djState: DJState = 'IDLE';
  @state() private _uptime = '00:00:00';
  @state() private _latency = '—';
  @state() private _decisions = 0;

  private _uptimeInterval: number | null = null;
  private _latencyInterval: number | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _startTime = Date.now();

  override connectedCallback(): void {
    super.connectedCallback();

    // Subscribe to AI DJ state changes
    this._unsubscribe = aiDjService.onChange(() => {
      this._djState = aiDjService.state;
      this._decisions++;
    });

    // Sync initial state
    this._djState = aiDjService.state;

    // Uptime clock
    this._uptimeInterval = window.setInterval(() => {
      const delta = Math.floor((Date.now() - this._startTime) / 1000);
      const h = String(Math.floor(delta / 3600)).padStart(2, '0');
      const m = String(Math.floor((delta % 3600) / 60)).padStart(2, '0');
      const s = String(delta % 60).padStart(2, '0');
      this._uptime = `${h}:${m}:${s}`;
    }, 1000);

    // Audio latency readout — poll every 5s
    this._latencyInterval = window.setInterval(() => this._refreshLatency(), 5000);
    this._refreshLatency();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) this._unsubscribe();
    if (this._uptimeInterval) clearInterval(this._uptimeInterval);
    if (this._latencyInterval) clearInterval(this._latencyInterval);
  }

  private _refreshLatency(): void {
    try {
      const ctx = audioEngine.getContext();
      const ms = Math.round((ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000);
      this._latency = `${ms}ms`;
    } catch {
      // AudioContext not yet initialised — leave as '—'
    }
  }

  override render() {
    const st = STATE_DISPLAY[this._djState];
    return html`
      <div class="section-label">AI STATUS</div>
      <div class="state-row">
        <span class="state-dot" style="background: ${st.color}; box-shadow: 0 0 6px ${st.color}"></span>
        <span class="state-label" style="color: ${st.color}">${st.label}</span>
      </div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Uptime</span>
          <span class="info-value">${this._uptime}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Model</span>
          <span class="info-value">CLAW-AI v2</span>
        </div>
        <div class="info-item">
          <span class="info-label">Latency</span>
          <span class="info-value">${this._latency}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Decisions</span>
          <span class="info-value">${this._decisions.toLocaleString()}</span>
        </div>
      </div>
      <div class="processing-bar">
        <div class="processing-fill"></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ai-status-panel': AiStatusPanel;
  }
}
