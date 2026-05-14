import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('status-bar')
export class StatusBar extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: var(--status-bar-h, 40px);
      font-family: var(--font-body);
    }

    .bar {
      display: flex;
      align-items: center;
      height: 100%;
      padding: 0 12px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--panel-border);
      box-sizing: border-box;
      gap: 0;
    }

    .section {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .spacer { flex: 1; }

    .divider {
      width: 1px;
      height: 18px;
      background: rgba(255, 255, 255, 0.08);
      margin: 0 10px;
    }

    .logo {
      font-family: var(--font-display);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--neo-cyan);
      user-select: none;
    }

    .live-badge {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid transparent;
      background: rgba(128, 128, 128, 0.1);
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
    }

    .live-badge:hover {
      background: rgba(128, 128, 128, 0.2);
    }

    .live-badge.active {
      border-color: rgba(255, 0, 60, 0.3);
      background: rgba(255, 0, 60, 0.08);
    }

    .live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #444;
      transition: all 0.15s ease;
    }

    .live-badge.active .live-dot {
      background: var(--status-live);
      box-shadow: 0 0 4px var(--status-live);
      animation: pulse-dot 1.2s ease-in-out infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .live-text {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: var(--text-dim);
      transition: color 0.15s ease;
    }

    .live-badge.active .live-text {
      color: var(--status-live);
    }

    .timer {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
      letter-spacing: 0.5px;
    }

    .ai-pill {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px;
      border-radius: 3px;
      border: 1px solid rgba(0, 240, 255, 0.15);
      background: rgba(0, 240, 255, 0.04);
    }

    .ai-pill-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--neo-cyan);
      animation: pulse-dot 2s ease-in-out infinite;
    }

    .ai-pill-text {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--neo-cyan);
      letter-spacing: 1px;
    }

    .clock {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
      letter-spacing: 0.5px;
    }

    .quality {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      letter-spacing: 1px;
    }

    .library-btn {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
      padding: 3px 10px;
      border-radius: 3px;
      border: 1px solid var(--panel-border);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
    }

    .library-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: var(--panel-border-active);
      color: var(--text-primary);
    }

    .library-btn.open {
      background: rgba(0, 240, 255, 0.08);
      border-color: rgba(0, 240, 255, 0.2);
      color: var(--neo-cyan);
    }
  `;

  @property({ type: Boolean }) isLive = false;
  @property({ type: Number }) sessionStart = 0;
  @property({ type: Boolean }) libraryOpen = false;
  @property({ type: Boolean }) settingsOpen = false;
  /** When true (OBS stream mode), interactive controls are hidden */
  @property({ type: Boolean }) streamMode = false;
  /** Whether the autonomous DJ chain is currently running */
  @property({ type: Boolean }) djRunning = false;
  /** Active claw mode: 'local' (no AI) or 'live' (full LLM/stream chain) */
  @property({ type: String }) flowMode: 'local' | 'live' = 'local';

  @state() private _elapsed = '00:00:00';
  @state() private _clock = '00:00:00';
  @state() private _starting = false;

  private _timerHandle: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this._startTimer();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopTimer();
  }

  private _startTimer(): void {
    this._updateElapsed();
    this._updateClock();
    this._timerHandle = window.setInterval(() => {
      this._updateElapsed();
      this._updateClock();
    }, 1000);
  }

  private _stopTimer(): void {
    if (this._timerHandle !== null) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
  }

  private _updateElapsed(): void {
    if (!this.sessionStart) {
      this._elapsed = '00:00:00';
      return;
    }
    const delta = Math.max(0, Math.floor((Date.now() - this.sessionStart) / 1000));
    const h = String(Math.floor(delta / 3600)).padStart(2, '0');
    const m = String(Math.floor((delta % 3600) / 60)).padStart(2, '0');
    const s = String(delta % 60).padStart(2, '0');
    this._elapsed = `${h}:${m}:${s}`;
  }

  private _updateClock(): void {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    this._clock = `${h}:${m}:${s}`;
  }

  private _onToggleLive(): void {
    this.dispatchEvent(new CustomEvent('toggle-live', { bubbles: true, composed: true }));
  }

  private _onToggleLibrary(): void {
    this.dispatchEvent(new CustomEvent('toggle-library', { bubbles: true, composed: true }));
  }

  private _onToggleSettings(): void {
    this.dispatchEvent(new CustomEvent('toggle-settings', { bubbles: true, composed: true }));
  }

  private async _onToggleDj(): Promise<void> {
    if (this._starting) return;
    this._starting = true;
    try {
      const endpoint = this.djRunning ? '/api/session/stop-auto' : '/api/session/start-auto';
      const body = this.djRunning ? undefined : JSON.stringify({ mode: this.flowMode });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body,
      });
      const data = await res.json();
      if (data?.ok) {
        this.dispatchEvent(new CustomEvent('dj-toggle', {
          detail: { running: !this.djRunning, mode: data.mode ?? this.flowMode },
          bubbles: true,
          composed: true,
        }));
      } else {
        alert(`Failed: ${data?.error ?? 'unknown error'}`);
      }
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this._starting = false;
    }
  }

  private async _onModeChange(e: Event): Promise<void> {
    const next = (e.target as HTMLSelectElement).value as 'local' | 'live';
    try {
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      this.dispatchEvent(new CustomEvent('mode-change', {
        detail: { mode: next },
        bubbles: true,
        composed: true,
      }));
    } catch (err) {
      console.warn('[status-bar] mode change failed:', err);
    }
  }

  render() {
    return html`
      <div class="bar">
        <div class="section">
          <span class="logo">FLOW DJ</span>
        </div>

        <span class="divider"></span>

        <div
          class="live-badge ${this.isLive ? 'active' : ''}"
          @click=${this._onToggleLive}
          role="button"
          tabindex="0"
          aria-label="Toggle live mode"
        >
          <span class="live-dot"></span>
          <span class="live-text">LIVE</span>
        </div>

        <span class="divider"></span>

        <span class="timer">${this._elapsed}</span>

        <span class="divider"></span>

        <div class="ai-pill">
          <span class="ai-pill-dot"></span>
          <span class="ai-pill-text">AI ACTIVE</span>
        </div>

        <span class="spacer"></span>

        <span class="clock">${this._clock}</span>
        <span class="divider"></span>
        <span class="quality">1080p60</span>
        <span class="divider"></span>

        ${!this.streamMode ? html`
          <select
            class="library-btn"
            style="padding: 6px 10px; cursor: pointer;"
            .value=${this.flowMode}
            @change=${this._onModeChange}
            aria-label="DJ mode"
            title="Local = music only (no AI). Live = full stream with Flow AI."
          >
            <option value="local" ?selected=${this.flowMode === 'local'}>LOCAL</option>
            <option value="live" ?selected=${this.flowMode === 'live'}>LIVE STREAM</option>
          </select>
          <span style="width:6px"></span>
          <button
            class="library-btn ${this.djRunning ? 'open' : ''}"
            style="${this.djRunning
              ? 'background: rgba(255,80,80,0.15); border-color: rgba(255,80,80,0.4); color: #ff7676;'
              : 'background: rgba(80,220,120,0.15); border-color: rgba(80,220,120,0.4); color: #6cdfa3;'}"
            @click=${this._onToggleDj}
            ?disabled=${this._starting}
            aria-label=${this.djRunning ? 'Stop DJ' : 'Start DJ'}
          >${this._starting ? '...' : this.djRunning ? '■ STOP' : '▶ START DJ'}</button>
          <span style="width:6px"></span>
          <button
            class="library-btn ${this.settingsOpen ? 'open' : ''}"
            @click=${this._onToggleSettings}
            aria-label="Toggle settings"
          >SETTINGS</button>
          <span style="width:6px"></span>
          <button
            class="library-btn ${this.libraryOpen ? 'open' : ''}"
            @click=${this._onToggleLibrary}
            aria-label="Toggle library"
          >LIBRARY</button>
        ` : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'status-bar': StatusBar;
  }
}
