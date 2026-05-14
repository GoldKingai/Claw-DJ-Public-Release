/**
 * YouTube OAuth2 Auth Service
 *
 * Handles the one-time OAuth2 authorization flow and token lifecycle.
 * After the user authorizes once, refresh tokens are persisted to disk
 * and access tokens are renewed automatically.
 *
 * Required Google Cloud Console setup:
 *   1. Create OAuth 2.0 Client ID (type: Web Application)
 *   2. Add authorized redirect URI: http://localhost:3001/api/broadcast/auth/callback
 *   3. Copy Client ID + Client Secret into Settings
 *
 * Scopes requested:
 *   https://www.googleapis.com/auth/youtube
 *   (allows creating/transitioning broadcasts)
 *
 * Config via env vars (optional — can also be set via Settings):
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REFRESH_TOKEN   ← skip the auth flow entirely if you have this
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '../data/oauth-tokens.json');

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = ['https://www.googleapis.com/auth/youtube'];

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenData {
  refreshToken: string;
  accessToken: string;
  expiresAt: number; // ms epoch
}

export interface AuthorizedChannel {
  id: string;
  title: string;
  thumbnailUrl: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

class YouTubeAuthService {
  private clientId     = '';
  private clientSecret = '';
  private redirectUri  = '';

  private _tokenData: TokenData | null = null;
  private _authorizedChannel: AuthorizedChannel | null = null;

  // ── Init ────────────────────────────────────────────────────────────────────

  initFromEnv(): void {
    const clientId     = process.env.YOUTUBE_CLIENT_ID     || '';
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
    const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '';
    const port         = process.env.PORT || '3001';

    if (clientId && clientSecret) {
      this.configure(
        clientId,
        clientSecret,
        `http://localhost:${port}/api/broadcast/auth/callback`
      );
      console.log('[YouTube Auth] Credentials loaded from environment');
    }

    if (refreshToken) {
      // Env-provided refresh token — skip the browser flow
      this._tokenData = { refreshToken, accessToken: '', expiresAt: 0 };
      console.log('[YouTube Auth] Refresh token loaded from environment');
    } else {
      this._loadTokenFile();
    }
  }

  configure(clientId: string, clientSecret: string, redirectUri: string): void {
    this.clientId     = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri  = redirectUri;
  }

  // ── Auth URL ─────────────────────────────────────────────────────────────────

  // CSRF protection for the OAuth round-trip. We generate a random `state`
  // when getAuthUrl() is called, remember it briefly (5 min TTL), and
  // require the callback URL to echo it back. Without this, an attacker
  // can trick the owner into completing an OAuth flow that authorises
  // the attacker's intended account on the owner's machine.
  private _pendingStates = new Map<string, number>(); // state → expires-at ms

  private _pruneExpiredStates(): void {
    const now = Date.now();
    for (const [s, exp] of this._pendingStates) {
      if (exp < now) this._pendingStates.delete(s);
    }
  }

  getAuthUrl(): string {
    this._pruneExpiredStates();
    // 32 bytes of crypto-random hex = 64 chars. Stored with 5-min expiry.
    const state = randomBytes(32).toString('hex');
    this._pendingStates.set(state, Date.now() + 5 * 60_000);
    const params = new URLSearchParams({
      client_id:     this.clientId,
      redirect_uri:  this.redirectUri,
      response_type: 'code',
      scope:         SCOPES.join(' '),
      access_type:   'offline',
      prompt:        'consent', // always return refresh_token
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params}`;
  }

  /** Verify and consume a `state` value returned on the OAuth callback. */
  verifyState(state: string | undefined): boolean {
    if (!state || typeof state !== 'string') return false;
    this._pruneExpiredStates();
    const exp = this._pendingStates.get(state);
    if (!exp || exp < Date.now()) return false;
    this._pendingStates.delete(state); // single-use
    return true;
  }

  // ── OAuth callback ───────────────────────────────────────────────────────────

  async handleCallback(code: string): Promise<void> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        redirect_uri:  this.redirectUri,
        grant_type:    'authorization_code',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const body = await res.json() as {
      access_token:   string;
      refresh_token?: string;
      expires_in:     number;
    };

    // Google only returns refresh_token on first authorization or when prompt=consent
    const refreshToken = body.refresh_token || this._tokenData?.refreshToken || '';

    if (!refreshToken) {
      throw new Error('No refresh token returned — try revoking access and re-authorizing');
    }

    this._tokenData = {
      refreshToken,
      accessToken: body.access_token,
      expiresAt:   Date.now() + (body.expires_in - 60) * 1000,
    };

    this._saveTokenFile();
    console.log('[YouTube Auth] Authorization successful — tokens saved');

    // Immediately identify which channel this token controls
    await this._fetchAuthorizedChannel().catch((err) =>
      console.warn('[YouTube Auth] Could not fetch channel info:', err)
    );
  }

  // ── Channel identity ──────────────────────────────────────────────────────────

  async fetchAuthorizedChannel(): Promise<AuthorizedChannel | null> {
    if (this._authorizedChannel) return this._authorizedChannel;
    if (!this.isAuthorized) return null;
    await this._fetchAuthorizedChannel().catch(() => {});
    return this._authorizedChannel;
  }

  private async _fetchAuthorizedChannel(): Promise<void> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({ part: 'snippet', mine: 'true' });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`channels.list failed (${res.status})`);

    const body = (await res.json()) as {
      items?: Array<{
        id: string;
        snippet: { title: string; thumbnails?: { default?: { url?: string } } };
      }>;
    };

    const item = body.items?.[0];
    if (!item) throw new Error('No channel found for this token');

    this._authorizedChannel = {
      id:           item.id,
      title:        item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails?.default?.url ?? '',
    };
    console.log(`[YouTube Auth] Authorized channel: ${this._authorizedChannel.title} (${this._authorizedChannel.id})`);
  }

  // ── Access token (auto-refresh) ───────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    if (!this._tokenData?.refreshToken) {
      throw new Error('Not authorized — complete OAuth2 flow first');
    }

    // Return cached token if still valid
    if (this._tokenData.accessToken && Date.now() < this._tokenData.expiresAt) {
      return this._tokenData.accessToken;
    }

    // Refresh
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this._tokenData.refreshToken,
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        grant_type:    'refresh_token',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      // Revoked/expired refresh token: clear stored auth so isAuthorized returns false
      if (errText.includes('invalid_grant')) {
        console.warn('[YouTubeAuth] Refresh token expired/revoked — clearing auth. Re-authorize in Settings.');
        this._tokenData = null;
      }
      throw new Error(`Token refresh failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const body = await res.json() as {
      access_token: string;
      expires_in:   number;
    };

    this._tokenData.accessToken = body.access_token;
    this._tokenData.expiresAt   = Date.now() + (body.expires_in - 60) * 1000;
    this._saveTokenFile();

    return this._tokenData.accessToken;
  }

  // ── Revoke ───────────────────────────────────────────────────────────────────

  async revoke(): Promise<void> {
    if (this._tokenData?.accessToken) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${this._tokenData.accessToken}`,
        { method: 'POST' }
      ).catch(() => { /* best effort */ });
    }
    this._tokenData = null;
    this._authorizedChannel = null;
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
    console.log('[YouTube Auth] Authorization revoked');
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  get isAuthorized(): boolean {
    return !!(this._tokenData?.refreshToken);
  }

  get isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  // ── Token file persistence ────────────────────────────────────────────────────

  private _loadTokenFile(): void {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
        this._tokenData = JSON.parse(raw) as TokenData;
        console.log('[YouTube Auth] Loaded saved refresh token from disk');
      }
    } catch {
      console.warn('[YouTube Auth] Could not load token file — will re-authorize if needed');
    }
  }

  private _saveTokenFile(): void {
    try {
      const dir = path.dirname(TOKEN_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 0600 — YouTube refresh token grants full channel access; protect from
      // other users on the host. (chmod no-op on win32.)
      fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify(this._tokenData, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
    } catch (err) {
      console.warn('[YouTube Auth] Could not save token file:', err);
    }
  }
}

export const youtubeAuthService = new YouTubeAuthService();
