import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface ChatMessage {
  user: string;
  text: string;
  isAI: boolean;
  color: string;
}

@customElement('live-chat-panel')
export class LiveChatPanel extends LitElement {
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

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .live-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--neo-lime);
      animation: live-pulse 1.5s ease-in-out infinite;
    }

    .live-dot.offline {
      background: rgba(255, 255, 255, 0.2);
      animation: none;
    }

    @keyframes live-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .live-label {
      font-family: var(--font-mono);
      font-size: 9px;
      letter-spacing: 1px;
      color: var(--neo-lime);
    }

    .live-label.offline {
      color: rgba(255, 255, 255, 0.2);
    }

    .chat-container {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      position: relative;
    }

    .chat-fade {
      position: sticky;
      top: 0;
      left: 0;
      right: 0;
      height: 20px;
      background: linear-gradient(180deg, var(--bg-elevated), transparent);
      pointer-events: none;
      z-index: 1;
      margin-bottom: -20px;
    }

    .chat-messages {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 20px;
    }

    .msg {
      line-height: 1.35;
      padding: 2px 0;
    }

    .msg-user {
      font-family: var(--font-body);
      font-size: 11px;
      font-weight: 700;
      margin-right: 5px;
    }

    .msg-text {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .msg-ai {
      padding: 4px 6px;
      background: rgba(0, 240, 255, 0.04);
      border-left: 2px solid rgba(0, 240, 255, 0.3);
      border-radius: 0 3px 3px 0;
    }

    .msg-ai .msg-user {
      color: var(--neo-cyan);
    }

    .msg-ai .msg-text {
      color: rgba(255, 255, 255, 0.75);
    }

    .ai-dot {
      display: inline-block;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--neo-cyan);
      margin-right: 4px;
      vertical-align: middle;
    }
  `;

  @state() private _messages: ChatMessage[] = [];
  @state() private _live = false;

  private _sse: EventSource | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._connectSSE();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  private _connectSSE(): void {
    try {
      const es = new EventSource('/api/chat/stream');

      es.onopen = () => {
        this._live = true;
        console.log('[LiveChatPanel] SSE connected — real chat active');
      };

      es.onmessage = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as { type: string; message: ChatMessage };
          if (payload.type === 'chat') {
            this._pushMessage(payload.message);
          }
        } catch {
          // Ignore malformed frames
        }
      };

      es.onerror = () => {
        if (this._live) {
          console.log('[LiveChatPanel] SSE disconnected');
          this._live = false;
        }
        es.close();
        this._sse = null;

        // Retry connection after 10 seconds
        window.setTimeout(() => this._connectSSE(), 10_000);
      };

      this._sse = es;
    } catch {
      // EventSource not supported — chat unavailable
    }
  }

  private _teardown(): void {
    if (this._sse) {
      this._sse.close();
      this._sse = null;
    }
  }

  private _pushMessage(msg: ChatMessage): void {
    this._messages = [...this._messages, msg];
    if (this._messages.length > 50) {
      this._messages = this._messages.slice(-50);
    }

    this.updateComplete.then(() => {
      const container = this.shadowRoot?.querySelector('.chat-container');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  override firstUpdated(): void {
    const container = this.shadowRoot?.querySelector('.chat-container');
    if (container) container.scrollTop = container.scrollHeight;
  }

  override render() {
    return html`
      <div class="header">
        <span class="section-label">LIVE CHAT</span>
        <div class="live-indicator">
          <span class="live-dot ${this._live ? '' : 'offline'}"></span>
          <span class="live-label ${this._live ? '' : 'offline'}">${this._live ? 'LIVE' : 'DEMO'}</span>
        </div>
      </div>
      <div class="chat-container">
        <div class="chat-fade"></div>
        <div class="chat-messages">
          ${this._messages.length === 0 ? html`
            <div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 16px 8px; font-family: var(--font-mono);">
              ${this._live ? 'Waiting for messages...' : 'Chat offline — not streaming'}
            </div>
          ` : this._messages.map(
            (msg) => html`
              <div class="msg ${msg.isAI ? 'msg-ai' : ''}">
                ${msg.isAI ? html`<span class="ai-dot"></span>` : ''}
                <span class="msg-user" style="${msg.isAI ? '' : `color: ${msg.color}`}">${msg.user}</span>
                <span class="msg-text">${msg.text}</span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'live-chat-panel': LiveChatPanel;
  }
}
