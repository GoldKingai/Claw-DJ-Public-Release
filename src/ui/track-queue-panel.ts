import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface QueueTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

@customElement('track-queue-panel')
export class TrackQueuePanel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 12px;
      overflow: hidden;
      min-height: 0;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      flex-shrink: 0;
    }

    .section-label {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--text-dim);
      flex: 1;
    }

    .queue-count {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
    }

    .track-list {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }

    .track-list::-webkit-scrollbar { width: 4px; }
    .track-list::-webkit-scrollbar-track { background: transparent; }
    .track-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

    .track-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 4px 5px 8px;
      border-radius: 3px;
      border-left: 2px solid transparent;
      transition: background 0.15s ease;
    }

    .track-row:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .track-row.next {
      border-left-color: var(--neo-cyan);
      background: rgba(0, 240, 255, 0.04);
    }

    .track-num {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      width: 18px;
      text-align: right;
      flex-shrink: 0;
    }

    .track-row.next .track-num {
      color: var(--neo-cyan);
    }

    .track-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .track-title {
      font-family: var(--font-body);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .track-artist {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .track-duration {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      flex-shrink: 0;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
  `;

  /** The queue data from AI DJ service */
  @property({ attribute: false }) queue: QueueTrack[] = [];

  private _formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  override render() {
    return html`
      <div class="header">
        <span class="section-label">QUEUE</span>
        ${this.queue.length > 0
          ? html`<span class="queue-count">${this.queue.length}</span>`
          : nothing}
      </div>
      ${this.queue.length > 0
        ? html`
            <div class="track-list">
              ${this.queue.map(
                (track, i) => html`
                  <div class="track-row ${i === 0 ? 'next' : ''}">
                    <span class="track-num">${String(i + 1).padStart(2, '0')}</span>
                    <div class="track-info">
                      <div class="track-title">${track.title}</div>
                      <div class="track-artist">${track.artist}</div>
                    </div>
                    <span class="track-duration">${this._formatDuration(track.duration)}</span>
                  </div>
                `,
              )}
            </div>
          `
        : html`<div class="empty-state">Queue empty</div>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'track-queue-panel': TrackQueuePanel;
  }
}
