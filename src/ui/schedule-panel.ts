import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// ── Types matching server/services/broadcast-scheduler.ts ─────────────────────

interface ScheduleEntry {
  id:           string;
  title:        string;
  days:         number[];
  startHH:      number;
  startMM:      number;
  durationMins: number;
  enabled:      boolean;
}

type SchedulerStatus = 'idle' | 'creating' | 'warming' | 'live' | 'ending' | 'error';

interface SchedulerState {
  status:       SchedulerStatus;
  activeEntry:  ScheduleEntry | null;
  startedAt:    number;
  endsAt:       number;
  lastError:    string;
  nextStream:   { entry: ScheduleEntry; startsAt: number } | null;
}

const DAY_ABBR = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];

@customElement('schedule-panel')
export class SchedulePanel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 10px 12px 12px;
      overflow: hidden;
      min-height: 0;
    }

    /* ── Header row ── */

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      flex-shrink: 0;
    }

    .section-label {
      font-family: var(--font-display);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    /* ── Status indicator ── */

    .status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      flex-shrink: 0;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.2);
    }

    .status-dot.pulsing {
      animation: sched-pulse 1.5s ease-in-out infinite;
    }

    @keyframes sched-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }

    .status-text {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .time-rem {
      font-family: var(--font-mono);
      font-size: 10px;
      color: rgba(255, 255, 255, 0.45);
      margin-left: auto;
    }

    .error-msg {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--status-live);
      margin-bottom: 6px;
      flex-shrink: 0;
      word-break: break-word;
    }

    /* ── Next stream ── */

    .next-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 5px;
      padding: 5px 6px;
      background: rgba(0, 240, 255, 0.04);
      border: 1px solid rgba(0, 240, 255, 0.08);
      border-radius: 4px;
      margin-bottom: 6px;
      flex-shrink: 0;
    }

    .next-label {
      font-family: var(--font-display);
      font-size: 8px;
      font-weight: 600;
      letter-spacing: 2px;
      color: var(--neo-cyan);
      text-transform: uppercase;
    }

    .next-time {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-primary);
      font-weight: 600;
    }

    .next-title {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      grid-column: 1 / 3;
      margin-top: 1px;
    }

    .next-countdown {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
      grid-column: 3;
      grid-row: 1 / 3;
      align-self: center;
    }

    /* ── Schedule entries list ── */

    .timeline {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }

    .timeline::-webkit-scrollbar { width: 3px; }
    .timeline::-webkit-scrollbar-track { background: transparent; }
    .timeline::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

    .entry {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 5px;
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.15s ease, opacity 0.15s ease;
    }

    .entry:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .entry.disabled {
      opacity: 0.38;
    }

    .entry-time {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      width: 34px;
      flex-shrink: 0;
    }

    .entry.disabled .entry-time {
      color: var(--text-dim);
    }

    .entry-info {
      flex: 1;
      min-width: 0;
    }

    .entry-title {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    .entry-meta {
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--text-dim);
      display: block;
      margin-top: 1px;
    }

    .toggle-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 7px;
      color: rgba(255, 255, 255, 0.3);
      transition: border-color 0.15s, color 0.15s;
    }

    .entry:not(.disabled) .toggle-icon {
      border-color: var(--neo-lime);
      color: var(--neo-lime);
    }

    .delete-btn {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      background: none;
      border: none;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.2);
      font-size: 13px;
      line-height: 1;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 2px;
      transition: color 0.15s, background 0.15s;
    }

    .delete-btn:hover {
      color: var(--status-live);
      background: rgba(255, 0, 60, 0.08);
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
      text-align: center;
      padding: 8px;
    }

    /* ── Action buttons ── */

    .action-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-shrink: 0;
    }

    .start-btn {
      flex: 1;
      padding: 5px 8px;
      background: rgba(0, 255, 102, 0.06);
      border: 1px solid rgba(0, 255, 102, 0.2);
      border-radius: 4px;
      color: var(--neo-lime);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }

    .start-btn:hover:not(:disabled) {
      background: rgba(0, 255, 102, 0.12);
      border-color: rgba(0, 255, 102, 0.35);
    }

    .start-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .stop-btn {
      padding: 5px 10px;
      background: rgba(255, 0, 60, 0.06);
      border: 1px solid rgba(255, 0, 60, 0.2);
      border-radius: 4px;
      color: var(--status-live);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      flex-shrink: 0;
    }

    .stop-btn:hover {
      background: rgba(255, 0, 60, 0.12);
      border-color: rgba(255, 0, 60, 0.35);
    }
  `;

  @state() private _status: SchedulerStatus = 'idle';
  @state() private _activeEntry: ScheduleEntry | null = null;
  @state() private _endsAt = 0;
  @state() private _lastError = '';
  @state() private _nextStream: { entry: ScheduleEntry; startsAt: number } | null = null;
  @state() private _schedule: ScheduleEntry[] = [];
  @state() private _timeRemaining = '';
  @state() private _timeToNext = '';
  @state() private _starting = false;

  private _pollInterval: number | null = null;
  private _tickInterval: number | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._fetchAll();
    this._pollInterval = window.setInterval(() => void this._fetchAll(), 10_000);
    this._tickInterval = window.setInterval(() => this._updateCountdowns(), 1_000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._tickInterval) clearInterval(this._tickInterval);
  }

  private async _fetchAll(): Promise<void> {
    try {
      const [stateRes, schedRes] = await Promise.all([
        fetch('/api/scheduler/state'),
        fetch('/api/scheduler/schedule'),
      ]);
      if (!stateRes.ok || !schedRes.ok) return;
      const stateData = await stateRes.json() as SchedulerState;
      const schedData = await schedRes.json() as ScheduleEntry[];

      this._status     = stateData.status;
      this._activeEntry = stateData.activeEntry;
      this._endsAt     = stateData.endsAt;
      this._lastError  = stateData.lastError;
      this._nextStream = stateData.nextStream;
      this._schedule   = schedData;
      this._updateCountdowns();
    } catch {
      // server not reachable — keep displaying last known state
    }
  }

  private _updateCountdowns(): void {
    const now = Date.now();

    if (this._endsAt > 0) {
      const rem = this._endsAt - now;
      if (rem > 0) {
        const m = Math.floor(rem / 60_000);
        const s = Math.floor((rem % 60_000) / 1_000);
        this._timeRemaining = `${m}:${s.toString().padStart(2, '0')}`;
      } else {
        this._timeRemaining = '0:00';
      }
    } else {
      this._timeRemaining = '';
    }

    if (this._nextStream) {
      const diff = this._nextStream.startsAt - now;
      if (diff > 0) {
        const totalMin = Math.floor(diff / 60_000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        if (h >= 48) {
          this._timeToNext = `${Math.floor(h / 24)}d`;
        } else if (h >= 24) {
          this._timeToNext = `${Math.floor(h / 24)}d ${h % 24}h`;
        } else if (h > 0) {
          this._timeToNext = `${h}h ${m}m`;
        } else {
          this._timeToNext = `${m}m`;
        }
      } else {
        this._timeToNext = 'soon';
      }
    } else {
      this._timeToNext = '';
    }
  }

  private _padTime(n: number): string {
    return n.toString().padStart(2, '0');
  }

  private _formatTime(hh: number, mm: number): string {
    return `${this._padTime(hh)}:${this._padTime(mm)}`;
  }

  private _formatDays(days: number[]): string {
    return [...days].sort((a, b) => a - b).map(d => DAY_ABBR[d]).join(' ');
  }

  private _formatDuration(mins: number): string {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }

  private _statusColor(): string {
    switch (this._status) {
      case 'live':     return 'var(--neo-lime)';
      case 'warming':
      case 'creating': return 'var(--status-warning)';
      case 'ending':   return 'rgba(255, 255, 255, 0.4)';
      case 'error':    return 'var(--status-live)';
      default:         return 'rgba(255, 255, 255, 0.2)';
    }
  }

  private _statusLabel(): string {
    switch (this._status) {
      case 'live':     return 'LIVE';
      case 'warming':  return 'WARMING';
      case 'creating': return 'CONNECTING';
      case 'ending':   return 'ENDING';
      case 'error':    return 'ERROR';
      default:         return 'IDLE';
    }
  }

  private async _startNow(): Promise<void> {
    this._starting = true;
    try {
      await fetch('/api/scheduler/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Live Stream', durationMins: 120 }),
      });
      await this._fetchAll();
    } catch {
      // ignore
    } finally {
      this._starting = false;
    }
  }

  private async _stopNow(): Promise<void> {
    try {
      await fetch('/api/scheduler/end', { method: 'POST' });
      await this._fetchAll();
    } catch {
      // ignore
    }
  }

  private async _deleteEntry(id: string, e: Event): Promise<void> {
    e.stopPropagation();
    try {
      await fetch(`/api/scheduler/schedule/${id}`, { method: 'DELETE' });
      await this._fetchAll();
    } catch {
      // ignore
    }
  }

  private async _toggleEntry(entry: ScheduleEntry): Promise<void> {
    try {
      await fetch(`/api/scheduler/schedule/${entry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      await this._fetchAll();
    } catch {
      // ignore
    }
  }

  override render() {
    const isActive = this._status !== 'idle' && this._status !== 'error';
    const isLive   = this._status === 'live' || this._status === 'warming' || this._status === 'creating';
    const dotColor = this._statusColor();

    return html`
      <div class="header">
        <span class="section-label">SCHEDULE</span>
      </div>

      <!-- Scheduler status -->
      <div class="status-row">
        <span class="status-dot ${isLive ? 'pulsing' : ''}"
              style="background: ${dotColor}"></span>
        <span class="status-text" style="color: ${dotColor}">${this._statusLabel()}</span>
        ${this._status === 'live' && this._timeRemaining ? html`
          <span class="time-rem">${this._timeRemaining} left</span>
        ` : nothing}
        ${this._status === 'live' && this._activeEntry ? html`
          <span class="time-rem" style="margin-left: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80px;"
                title="${this._activeEntry.title}">${this._activeEntry.title}</span>
        ` : nothing}
      </div>

      ${this._status === 'error' ? html`
        <div class="error-msg">${this._lastError || 'Unknown error'}</div>
      ` : nothing}

      <!-- Next stream -->
      ${this._nextStream && !isLive ? html`
        <div class="next-row">
          <span class="next-label">NEXT</span>
          <span class="next-time">${this._formatTime(this._nextStream.entry.startHH, this._nextStream.entry.startMM)}</span>
          <span class="next-countdown">${this._timeToNext}</span>
          <span class="next-title">${this._nextStream.entry.title}</span>
        </div>
      ` : nothing}

      <!-- Schedule entries -->
      <div class="timeline">
        ${this._schedule.length > 0
          ? this._schedule.map(entry => html`
              <div class="entry ${!entry.enabled ? 'disabled' : ''}"
                   @click=${() => this._toggleEntry(entry)}>
                <span class="entry-time">${this._formatTime(entry.startHH, entry.startMM)}</span>
                <div class="entry-info">
                  <span class="entry-title">${entry.title}</span>
                  <span class="entry-meta">${this._formatDays(entry.days)} · ${this._formatDuration(entry.durationMins)}</span>
                </div>
                <span class="toggle-icon">${entry.enabled ? '●' : '○'}</span>
                <button class="delete-btn"
                        title="Remove entry"
                        @click=${(e: Event) => this._deleteEntry(entry.id, e)}>×</button>
              </div>
            `)
          : html`<div class="empty-state">No weekly schedule<br>Add entries in Settings</div>`
        }
      </div>

      <!-- Action buttons -->
      <div class="action-row">
        ${isLive ? html`
          <button class="stop-btn" @click=${this._stopNow}>■ STOP STREAM</button>
        ` : html`
          <button class="start-btn"
                  ?disabled=${this._starting || isActive}
                  @click=${this._startNow}>
            ${this._starting ? 'CONNECTING...' : '▶ START NOW'}
          </button>
        `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'schedule-panel': SchedulePanel;
  }
}
