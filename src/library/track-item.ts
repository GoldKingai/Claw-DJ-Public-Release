import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('track-item')
export class TrackItem extends LitElement {
  @property({ type: String, attribute: 'track-id' }) trackId = '';
  @property({ type: String }) title = '';
  @property({ type: String }) artist = '';
  @property({ type: Number }) duration = 0;
  @property({ type: Number }) bpm: number | null = null;
  @property({ type: String }) genre = '';

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-body);
    }

    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 4px;
      border-left: 2px solid transparent;
      cursor: default;
      transition: all 0.15s ease;
    }

    .row:hover {
      background: rgba(255, 255, 255, 0.03);
      border-left-color: rgba(255, 255, 255, 0.12);
    }

    .info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .title {
      font-family: var(--font-body);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .artist {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .genre-tag {
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--text-dim);
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }

    .stats {
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      flex-shrink: 0;
    }

    .bpm {
      color: var(--neo-cyan);
      min-width: 48px;
      text-align: right;
    }

    .duration {
      min-width: 34px;
      text-align: right;
      color: var(--text-secondary);
    }

    .deck-buttons {
      display: flex;
      gap: 3px;
      flex-shrink: 0;
      opacity: 0.5;
      transition: opacity 0.15s ease;
    }

    .row:hover .deck-buttons {
      opacity: 1;
    }

    .deck-btn {
      width: 26px;
      height: 26px;
      border: 1px solid var(--panel-border);
      border-radius: 3px;
      background: transparent;
      color: var(--text-secondary);
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .deck-btn:hover {
      background: rgba(0, 240, 255, 0.12);
      border-color: rgba(0, 240, 255, 0.4);
      color: var(--neo-cyan);
    }

    .deck-btn:active {
      transform: scale(0.92);
    }

    .deck-btn.b:hover {
      background: rgba(255, 0, 170, 0.12);
      border-color: rgba(255, 0, 170, 0.4);
      color: var(--neo-magenta);
    }
  `;

  private formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private handleDeckLoad(deck: 'A' | 'B') {
    this.dispatchEvent(
      new CustomEvent('load-to-deck', {
        detail: { trackId: this.trackId, deck },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <div class="row">
        <div class="info">
          <span class="title">${this.title}</span>
          <div class="meta">
            <span class="artist">${this.artist}</span>
            ${this.genre
              ? html`<span class="genre-tag">${this.genre}</span>`
              : nothing}
          </div>
        </div>
        <div class="stats">
          <span class="duration">${this.formatDuration(this.duration)}</span>
          <span class="bpm">${this.bpm != null ? `${this.bpm}` : '---'}</span>
        </div>
        <div class="deck-buttons">
          <button class="deck-btn a" title="Load to Deck A" @click=${() => this.handleDeckLoad('A')}>A</button>
          <button class="deck-btn b" title="Load to Deck B" @click=${() => this.handleDeckLoad('B')}>B</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'track-item': TrackItem;
  }
}
