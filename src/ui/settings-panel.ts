import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const LS_API_KEY       = 'flowdj:yt-api-key';
const LS_CHANNEL_ID    = 'flowdj:yt-channel-id';
const LS_CLIENT_ID     = 'flowdj:yt-client-id';
const LS_CLIENT_SECRET = 'flowdj:yt-client-secret';
const LS_OBS_URL       = 'flowdj:obs-url';
const LS_OBS_PASSWORD  = 'flowdj:obs-password';

type KeyStatus = 'idle' | 'testing' | 'ok' | 'error';

interface StreamStatus {
  configured: boolean;
  isLive: boolean;
  videoId: string;
  liveChatId: string;
  detectedAt: number;
}

@customElement('settings-panel')
export class SettingsPanel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-surface);
      border-right: 1px solid var(--panel-border);
      box-sizing: border-box;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      height: var(--status-bar-h, 40px);
      border-bottom: 1px solid var(--panel-border);
      flex-shrink: 0;
    }

    .panel-title {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    .close-btn {
      width: 24px;
      height: 24px;
      border-radius: 3px;
      border: 1px solid var(--panel-border);
      background: transparent;
      color: var(--text-dim);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      padding: 0;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
    }

    .section-title {
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--text-dim);
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .status-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 9px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.ok       { background: var(--neo-lime); box-shadow: 0 0 4px var(--neo-lime); }
    .status-dot.error    { background: var(--neo-magenta); }
    .status-dot.testing  { background: #ffaa00; animation: pulse 1s ease-in-out infinite; }
    .status-dot.watching { background: #ffaa00; animation: pulse 1s ease-in-out infinite; }
    .status-dot.idle     { background: rgba(255,255,255,0.2); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }

    .status-text {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .field-hint {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      line-height: 1.4;
    }

    .input-row {
      display: flex;
      gap: 6px;
    }

    .field-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--panel-border);
      border-radius: 3px;
      padding: 7px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.15s ease;
      min-width: 0;
    }

    .field-input:focus {
      border-color: rgba(0, 240, 255, 0.3);
    }

    .field-input.saved {
      border-color: rgba(100, 255, 100, 0.2);
    }

    .field-input::placeholder {
      color: var(--text-dim);
    }

    .btn-row {
      display: flex;
      gap: 6px;
    }

    .btn {
      flex: 1;
      padding: 8px;
      border-radius: 3px;
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1.5px;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid var(--panel-border);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
    }

    .btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
    }

    .btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .btn.primary {
      border-color: rgba(0, 240, 255, 0.2);
      background: rgba(0, 240, 255, 0.05);
      color: var(--neo-cyan);
    }

    .btn.primary:hover:not(:disabled) {
      background: rgba(0, 240, 255, 0.1);
      border-color: rgba(0, 240, 255, 0.35);
    }

    .btn.danger {
      border-color: rgba(255, 60, 100, 0.15);
      background: rgba(255, 60, 100, 0.04);
      color: rgba(255, 100, 120, 0.7);
    }

    .btn.danger:hover:not(:disabled) {
      background: rgba(255, 60, 100, 0.08);
      color: rgba(255, 100, 120, 1);
    }

    .show-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--panel-border);
      border-radius: 3px;
      padding: 0 9px;
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 10px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .show-btn:hover {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.07);
    }

    .detected-info {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 10px;
      padding: 10px;
      border-radius: 3px;
      background: rgba(0, 240, 255, 0.02);
      border: 1px solid rgba(0, 240, 255, 0.06);
    }

    .det-label {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
      white-space: nowrap;
    }

    .det-value {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--neo-cyan);
      word-break: break-all;
    }

    .connect-hint {
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      line-height: 1.4;
      text-align: center;
    }

    .info-block {
      padding: 10px;
      border-radius: 3px;
      background: rgba(0, 240, 255, 0.02);
      border: 1px solid rgba(0, 240, 255, 0.06);
      font-family: var(--font-body);
      font-size: 10px;
      color: var(--text-dim);
      line-height: 1.5;
    }

    .info-block p { margin: 0 0 5px; }
    .info-block p:last-child { margin: 0; }

    code {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--neo-cyan);
      background: rgba(0, 240, 255, 0.08);
      padding: 1px 4px;
      border-radius: 2px;
    }
  `;

  // ── State ────────────────────────────────────────────────────────────────────

  @state() private _apiKey = '';
  @state() private _showKey = false;
  @state() private _keyStatus: KeyStatus = 'idle';
  @state() private _keyMsg = 'Not saved';

  @state() private _channelId = '';
  @state() private _channelSaved = false;
  @state() private _showChannelId = false;

  @state() private _detectStatus: 'idle' | 'ok' | 'watching' | 'error' = 'idle';
  @state() private _detectMsg = '';
  @state() private _streamInfo: StreamStatus | null = null;

  // ── OAuth state ──────────────────────────────────────────────────────────────
  @state() private _clientId = '';
  @state() private _clientSecret = '';
  @state() private _showClientSecret = false;
  @state() private _oauthStatus: 'idle' | 'ok' | 'error' = 'idle';
  @state() private _oauthMsg = '';
  @state() private _oauthChannel: { id: string; title: string; thumbnailUrl: string } | null = null;

  // ── OBS state ─────────────────────────────────────────────────────────────────
  @state() private _obsUrl = 'ws://localhost:4455';
  @state() private _obsPassword = '';
  @state() private _showObsPassword = false;
  @state() private _obsStatus: 'idle' | 'ok' | 'testing' | 'error' = 'idle';
  @state() private _obsMsg = '';
  @state() private _obsStreaming = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  override connectedCallback(): void {
    super.connectedCallback();

    const savedKey       = localStorage.getItem(LS_API_KEY)    ?? '';
    const savedChannelId = localStorage.getItem(LS_CHANNEL_ID) ?? '';

    if (savedKey) {
      this._apiKey    = savedKey;
      this._keyStatus = 'ok';
      this._keyMsg    = 'Saved (untested this session)';
    }

    if (savedChannelId) {
      this._channelId    = savedChannelId;
      this._channelSaved = true;
    }

    const savedClientId     = localStorage.getItem(LS_CLIENT_ID)     ?? '';
    const savedClientSecret = localStorage.getItem(LS_CLIENT_SECRET) ?? '';

    if (savedClientId)     this._clientId     = savedClientId;
    if (savedClientSecret) this._clientSecret = savedClientSecret;

    // Auto-start detection if both credentials are present
    if (savedKey && savedChannelId) {
      this._startDetection(false);
    } else {
      this._refreshDetectionStatus();
    }

    // Re-push OAuth credentials to server on every load (server may have restarted)
    if (savedClientId && savedClientSecret) {
      void this._pushOAuthCredsToServer(savedClientId, savedClientSecret);
    }

    // Check OAuth status
    void this._refreshOAuthStatus();

    // Restore OBS config
    const savedObsUrl      = localStorage.getItem(LS_OBS_URL)      ?? '';
    const savedObsPassword = localStorage.getItem(LS_OBS_PASSWORD) ?? '';
    if (savedObsUrl)      this._obsUrl      = savedObsUrl;
    if (savedObsPassword) this._obsPassword = savedObsPassword;

    // Check OBS status
    void this._refreshObsStatus();
  }

  // ── API Key ──────────────────────────────────────────────────────────────────

  private _saveKey(): void {
    const key = this._apiKey.trim();
    if (!key) return;
    localStorage.setItem(LS_API_KEY, key);
    this._keyStatus = 'ok';
    this._keyMsg = 'Saved — click Test to verify';
  }

  private async _testKey(): Promise<void> {
    const key = this._apiKey.trim();
    if (!key) return;

    this._keyStatus = 'testing';
    this._keyMsg = 'Testing...';

    try {
      const res  = await fetch(`/api/chat/test-key?apiKey=${encodeURIComponent(key)}`);
      const data = await res.json() as { ok: boolean; error?: string };

      if (data.ok) {
        this._keyStatus = 'ok';
        this._keyMsg = 'Valid — YouTube Data API v3 confirmed';
        localStorage.setItem(LS_API_KEY, key);
      } else {
        this._keyStatus = 'error';
        this._keyMsg = data.error ?? 'Invalid key';
      }
    } catch {
      this._keyStatus = 'error';
      this._keyMsg = 'Cannot reach server';
    }
  }

  private _clearKey(): void {
    this._apiKey    = '';
    this._keyStatus = 'idle';
    this._keyMsg    = 'Not saved';
    localStorage.removeItem(LS_API_KEY);
  }

  // ── Channel ID ───────────────────────────────────────────────────────────────

  private _saveChannelId(): void {
    const id = this._channelId.trim();
    if (!id) return;
    localStorage.setItem(LS_CHANNEL_ID, id);
    this._channelSaved = true;
  }

  private _clearChannelId(): void {
    this._channelId    = '';
    this._channelSaved = false;
    localStorage.removeItem(LS_CHANNEL_ID);
  }

  // ── Detection ────────────────────────────────────────────────────────────────

  private async _startDetection(showFeedback = true): Promise<void> {
    const key       = this._apiKey.trim()    || localStorage.getItem(LS_API_KEY)    || '';
    const channelId = this._channelId.trim() || localStorage.getItem(LS_CHANNEL_ID) || '';
    if (!key || !channelId) return;

    try {
      const res = await fetch('/api/stream/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key, channelId }),
      });

      if (res.ok) {
        this._detectStatus = 'watching';
        this._detectMsg = showFeedback
          ? 'Auto-detection started — polling every 60s'
          : 'Detection active';
        void this._refreshDetectionStatus();
      } else {
        const body = await res.json() as { error?: string };
        this._detectStatus = 'error';
        this._detectMsg = body.error ?? 'Failed to start';
      }
    } catch {
      this._detectStatus = 'error';
      this._detectMsg = 'Cannot reach server';
    }
  }

  private async _refreshDetectionStatus(): Promise<void> {
    try {
      const res = await fetch('/api/stream/status');
      if (!res.ok) return;
      const data = await res.json() as StreamStatus & { configured: boolean };
      this._streamInfo = data;
      if (data.configured) {
        if (data.isLive) {
          this._detectStatus = 'ok';
          this._detectMsg = 'Live stream detected';
        } else {
          this._detectStatus = 'watching';
          this._detectMsg = 'Watching for live stream...';
        }
      }
    } catch { /* server not ready */ }
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────────

  private async _pushOAuthCredsToServer(clientId: string, clientSecret: string): Promise<void> {
    try {
      await fetch('/api/broadcast/auth/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });
    } catch { /* server not ready yet */ }
  }

  private async _saveOAuthCreds(): Promise<void> {
    const clientId     = this._clientId.trim();
    const clientSecret = this._clientSecret.trim();
    if (!clientId || !clientSecret) return;

    localStorage.setItem(LS_CLIENT_ID,     clientId);
    localStorage.setItem(LS_CLIENT_SECRET, clientSecret);

    try {
      const res = await fetch('/api/broadcast/auth/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });

      if (res.ok) {
        this._oauthStatus = 'idle';
        this._oauthMsg    = 'Credentials saved — click Authorize to connect';
      } else {
        const body = await res.json() as { error?: string };
        this._oauthStatus = 'error';
        this._oauthMsg    = body.error ?? 'Failed to save';
      }
    } catch {
      this._oauthStatus = 'error';
      this._oauthMsg    = 'Cannot reach server';
    }
  }

  private async _authorize(): Promise<void> {
    try {
      const res  = await fetch('/api/broadcast/auth/url');
      const data = await res.json() as { url?: string; error?: string };

      if (data.url) {
        window.open(data.url, '_blank', 'width=600,height=700');
        // Poll for completion
        this._oauthStatus = 'idle';
        this._oauthMsg    = 'Waiting for authorization in browser...';
        this._pollOAuthStatus();
      } else {
        this._oauthStatus = 'error';
        this._oauthMsg    = data.error ?? 'Could not get auth URL — save credentials first';
      }
    } catch {
      this._oauthStatus = 'error';
      this._oauthMsg    = 'Cannot reach server';
    }
  }

  private _pollOAuthStatus(): void {
    let attempts = 0;
    const interval = window.setInterval(async () => {
      attempts++;
      await this._refreshOAuthStatus();
      if (this._oauthStatus === 'ok' || attempts >= 60) {
        clearInterval(interval);
      }
    }, 3000);
  }

  private async _refreshOAuthStatus(): Promise<void> {
    try {
      const res  = await fetch('/api/broadcast/auth/status');
      if (!res.ok) return;
      const data = await res.json() as {
        configured: boolean;
        authorized: boolean;
        channel?: { id: string; title: string; thumbnailUrl: string } | null;
      };

      if (data.authorized) {
        this._oauthStatus  = 'ok';
        this._oauthChannel = data.channel ?? null;

        const savedChannelId = localStorage.getItem(LS_CHANNEL_ID) ?? '';
        if (data.channel && savedChannelId && data.channel.id !== savedChannelId) {
          // Token is for the wrong channel
          this._oauthStatus = 'error';
          this._oauthMsg    = `Wrong channel! Token controls "${data.channel.title}" (${data.channel.id}) — not your target channel. Revoke and re-authorize while signed in to the correct account.`;
        } else {
          this._oauthMsg = data.channel
            ? `Authorized — ${data.channel.title}`
            : 'Authorized — broadcast control active';
        }
      } else if (data.configured) {
        this._oauthStatus  = 'idle';
        this._oauthChannel = null;
        this._oauthMsg     = 'Credentials saved — not yet authorized';
      }
    } catch { /* server not ready */ }
  }

  private async _revokeOAuth(): Promise<void> {
    try {
      await fetch('/api/broadcast/auth/revoke', { method: 'POST' });
      this._oauthStatus = 'idle';
      this._oauthMsg    = 'Authorization revoked';
    } catch {
      this._oauthStatus = 'error';
      this._oauthMsg    = 'Revoke failed';
    }
  }

  // ── OBS ──────────────────────────────────────────────────────────────────────

  private async _connectObs(): Promise<void> {
    const url      = this._obsUrl.trim()      || 'ws://localhost:4455';
    const password = this._obsPassword.trim() || '';

    localStorage.setItem(LS_OBS_URL,      url);
    localStorage.setItem(LS_OBS_PASSWORD, password);

    this._obsStatus = 'testing';
    this._obsMsg    = 'Connecting...';

    try {
      const res = await fetch('/api/obs/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, password }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        this._obsStatus = 'error';
        this._obsMsg    = body.error ?? 'Config failed';
        return;
      }

      // Poll for connection
      let attempts = 0;
      const poll = window.setInterval(async () => {
        attempts++;
        await this._refreshObsStatus();
        if (this._obsStatus === 'ok' || this._obsStatus === 'error' || attempts >= 10) {
          clearInterval(poll);
          if (this._obsStatus === 'testing') {
            this._obsStatus = 'error';
            this._obsMsg    = 'OBS did not respond — check it is running';
          }
        }
      }, 800);
    } catch {
      this._obsStatus = 'error';
      this._obsMsg    = 'Cannot reach server';
    }
  }

  private async _refreshObsStatus(): Promise<void> {
    try {
      const res = await fetch('/api/obs/status');
      if (!res.ok) return;
      const data = await res.json() as { connected: boolean; streaming: boolean; recording: boolean };
      if (data.connected) {
        this._obsStatus    = 'ok';
        this._obsStreaming  = data.streaming;
        this._obsMsg       = data.streaming ? 'Connected — streaming active' : 'Connected — standby';
      } else {
        this._obsStreaming = false;
        if (this._obsStatus !== 'testing') {
          this._obsStatus = 'idle';
          this._obsMsg    = '';
        }
      }
    } catch { /* server not ready */ }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private get _canDetect(): boolean {
    const key       = this._apiKey.trim()    || localStorage.getItem(LS_API_KEY)    || '';
    const channelId = this._channelId.trim() || localStorage.getItem(LS_CHANNEL_ID) || '';
    return Boolean(key && channelId);
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  override render() {
    const info = this._streamInfo;

    return html`
      <div class="panel-header">
        <span class="panel-title">SETTINGS</span>
        <button class="close-btn" @click=${this._close}>✕</button>
      </div>

      <div class="content">

        <!-- ══ API KEY ════════════════════════════════════════ -->
        <div class="section">
          <div class="section-title">YouTube API Key</div>

          <div class="status-row">
            <span class="status-dot ${this._keyStatus}"></span>
            <span class="status-text">${this._keyMsg}</span>
          </div>

          <div class="field">
            <div class="input-row">
              <input
                class="field-input ${this._keyStatus === 'ok' ? 'saved' : ''}"
                type=${this._showKey ? 'text' : 'password'}
                placeholder="AIza..."
                .value=${this._apiKey}
                @input=${(e: InputEvent) => { this._apiKey = (e.target as HTMLInputElement).value; }}
                autocomplete="off"
                spellcheck="false"
              />
              <button class="show-btn" @click=${() => { this._showKey = !this._showKey; }}>
                ${this._showKey ? 'HIDE' : 'SHOW'}
              </button>
            </div>
            <span class="field-hint">
              YouTube Data API v3 key from Google Cloud Console. Set once — never changes.
            </span>
          </div>

          <div class="btn-row">
            <button
              class="btn"
              ?disabled=${!this._apiKey.trim()}
              @click=${this._saveKey}
            >SAVE</button>
            <button
              class="btn primary"
              ?disabled=${!this._apiKey.trim() || this._keyStatus === 'testing'}
              @click=${this._testKey}
            >${this._keyStatus === 'testing' ? 'TESTING...' : 'TEST KEY'}</button>
            ${this._apiKey ? html`
              <button class="btn danger" @click=${this._clearKey}>CLEAR</button>
            ` : ''}
          </div>
        </div>

        <!-- ══ CHANNEL ID ════════════════════════════════════ -->
        <div class="section">
          <div class="section-title">Channel ID</div>

          <div class="field">
            <div class="input-row">
              <input
                class="field-input ${this._channelSaved ? 'saved' : ''}"
                type=${this._showChannelId ? 'text' : 'password'}
                placeholder="UCxxxxxxxxxxxxxxxxxx"
                .value=${this._channelId}
                @input=${(e: InputEvent) => {
                  this._channelId    = (e.target as HTMLInputElement).value;
                  this._channelSaved = false;
                }}
                autocomplete="off"
                spellcheck="false"
              />
              <button class="show-btn" @click=${() => { this._showChannelId = !this._showChannelId; }}>
                ${this._showChannelId ? 'HIDE' : 'SHOW'}
              </button>
            </div>
            <span class="field-hint">
              Starts with <code>UC</code>. Permanent — never changes for your channel.
              Find it via: YouTube Studio → Settings → Channel → Advanced.
            </span>
          </div>

          <div class="btn-row">
            <button
              class="btn primary"
              ?disabled=${!this._channelId.trim()}
              @click=${this._saveChannelId}
            >SAVE</button>
            ${this._channelId ? html`
              <button class="btn danger" @click=${this._clearChannelId}>CLEAR</button>
            ` : ''}
          </div>
        </div>

        <!-- ══ AUTO-DETECTION ════════════════════════════════ -->
        <div class="section">
          <div class="section-title">Stream Auto-Detection</div>

          <div class="info-block">
            <p>Once started, the system polls YouTube every 60 s. When a live stream is detected on your channel, the Video ID and Live Chat ID are fetched automatically — no manual entry required.</p>
          </div>

          ${this._detectStatus !== 'idle' ? html`
            <div class="status-row">
              <span class="status-dot ${this._detectStatus}"></span>
              <span class="status-text">${this._detectMsg}</span>
            </div>
          ` : ''}

          ${info?.isLive ? html`
            <div class="detected-info">
              <span class="det-label">Video ID</span>
              <span class="det-value">${info.videoId || '—'}</span>
              <span class="det-label">Chat ID</span>
              <span class="det-value">${info.liveChatId || '—'}</span>
            </div>
          ` : ''}

          <button
            class="btn primary"
            ?disabled=${!this._canDetect}
            @click=${() => this._startDetection(true)}
          >START AUTO-DETECTION</button>

          ${!this._canDetect ? html`
            <span class="connect-hint">
              Save API Key and Channel ID above first.
            </span>
          ` : ''}
        </div>

        <!-- ══ OAUTH2 — BROADCAST CONTROL ═══════════════════ -->
        <div class="section">
          <div class="section-title">YouTube Account — Broadcast Control</div>

          <div class="info-block">
            <p>Required for the AI to <b>create, start, and end</b> live broadcasts autonomously. Uses OAuth 2.0 — authorize once, works forever.</p>
            <p>In Google Cloud Console: create an <b>OAuth 2.0 Client ID</b> (Web Application). Add redirect URI: <code>http://localhost:3001/api/broadcast/auth/callback</code></p>
          </div>

          ${this._oauthStatus !== 'idle' || this._oauthMsg ? html`
            <div class="status-row">
              <span class="status-dot ${this._oauthStatus}"></span>
              <span class="status-text">${this._oauthMsg}</span>
            </div>
          ` : ''}

          ${this._oauthStatus === 'ok' && this._oauthChannel ? html`
            <div class="detected-info">
              <span class="det-label">Channel</span>
              <span class="det-value">${this._oauthChannel.title}</span>
              <span class="det-label">Channel ID</span>
              <span class="det-value">${this._oauthChannel.id}</span>
            </div>
          ` : ''}

          <div class="field">
            <input
              class="field-input"
              type="text"
              placeholder="Client ID — ends in .apps.googleusercontent.com"
              .value=${this._clientId}
              @input=${(e: InputEvent) => { this._clientId = (e.target as HTMLInputElement).value; }}
              autocomplete="off"
              spellcheck="false"
            />
          </div>

          <div class="field">
            <div class="input-row">
              <input
                class="field-input"
                type=${this._showClientSecret ? 'text' : 'password'}
                placeholder="Client Secret"
                .value=${this._clientSecret}
                @input=${(e: InputEvent) => { this._clientSecret = (e.target as HTMLInputElement).value; }}
                autocomplete="off"
                spellcheck="false"
              />
              <button class="show-btn" @click=${() => { this._showClientSecret = !this._showClientSecret; }}>
                ${this._showClientSecret ? 'HIDE' : 'SHOW'}
              </button>
            </div>
          </div>

          <div class="btn-row">
            <button
              class="btn"
              ?disabled=${!this._clientId.trim() || !this._clientSecret.trim()}
              @click=${this._saveOAuthCreds}
            >SAVE</button>
            <button
              class="btn primary"
              ?disabled=${!this._clientId.trim() || !this._clientSecret.trim()}
              @click=${this._authorize}
            >${this._oauthStatus === 'ok' ? 'RE-AUTHORIZE' : 'AUTHORIZE'}</button>
            ${this._oauthStatus === 'ok' ? html`
              <button class="btn danger" @click=${this._revokeOAuth}>REVOKE</button>
            ` : ''}
          </div>
        </div>

        <!-- ══ OBS WEBSOCKET ════════════════════════════════ -->
        <div class="section">
          <div class="section-title">OBS Studio — WebSocket</div>

          <div class="info-block">
            <p>Allows FlowDJ to start and stop OBS streaming automatically.</p>
            <p>In OBS: <b>Tools → WebSocket Server Settings</b> → enable + set password. Default port: <code>4455</code>.</p>
          </div>

          ${this._obsStatus !== 'idle' || this._obsMsg ? html`
            <div class="status-row">
              <span class="status-dot ${this._obsStatus}"></span>
              <span class="status-text">${this._obsMsg || (this._obsStreaming ? 'STREAMING' : 'Standby')}</span>
            </div>
          ` : ''}

          <div class="field">
            <input
              class="field-input"
              type="text"
              placeholder="ws://localhost:4455"
              .value=${this._obsUrl}
              @input=${(e: InputEvent) => { this._obsUrl = (e.target as HTMLInputElement).value; }}
              autocomplete="off"
              spellcheck="false"
            />
            <span class="field-hint">WebSocket URL — default <code>ws://localhost:4455</code></span>
          </div>

          <div class="field">
            <div class="input-row">
              <input
                class="field-input"
                type=${this._showObsPassword ? 'text' : 'password'}
                placeholder="WebSocket password (if set)"
                .value=${this._obsPassword}
                @input=${(e: InputEvent) => { this._obsPassword = (e.target as HTMLInputElement).value; }}
                autocomplete="off"
                spellcheck="false"
              />
              <button class="show-btn" @click=${() => { this._showObsPassword = !this._showObsPassword; }}>
                ${this._showObsPassword ? 'HIDE' : 'SHOW'}
              </button>
            </div>
          </div>

          <button
            class="btn primary"
            ?disabled=${this._obsStatus === 'testing'}
            @click=${this._connectObs}
          >${this._obsStatus === 'testing' ? 'CONNECTING...' : this._obsStatus === 'ok' ? 'RECONNECT' : 'CONNECT'}</button>
        </div>

      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-panel': SettingsPanel;
  }
}
