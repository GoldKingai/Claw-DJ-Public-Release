/**
 * YouTube Live Chat Service
 *
 * Polls the YouTube Data API v3 for live chat messages, filters them,
 * and distributes them to SSE clients. Periodically picks a random message
 * from the clean pool and fires a response via the registered AI handler.
 *
 * Config via environment variables (or POST /api/chat/config at runtime):
 *   YOUTUBE_API_KEY       — YouTube Data API v3 key
 *   YOUTUBE_LIVE_CHAT_ID  — Live chat ID (from the broadcast's liveChatId field)
 *
 * AI response generation is handled externally — register a handler via
 * youtubeChatService.setResponseHandler(fn) to wire in LLM Gateway or any other provider.
 */

import { opsMemory } from './ops-memory.js';
import { chatOrchestrator } from './chat-orchestrator.js';
import { youtubeAuthService } from './youtube-auth.js';
import { pollManager } from './poll-manager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  user: string;
  text: string;
  isAI: boolean;
  color: string;
}

type SSEClient = (data: object) => void;

interface PoolMessage {
  id: string;
  user: string;
  authorChannelId: string;
  text: string;
  color: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const USER_COLORS = [
  'rgba(255, 255, 255, 0.85)',
  'rgba(120, 200, 255, 0.85)',
  'rgba(200, 160, 255, 0.85)',
  'rgba(255, 180, 120, 0.85)',
  'rgba(120, 255, 180, 0.85)',
];

// Layer 1 filter — regex patterns that immediately discard a message.
// Any message matching one of these never enters the response pool.
const BANNED_PATTERNS: RegExp[] = [
  /https?:\/\//i,          // URLs
  /discord\.gg/i,          // Discord invite links
  /t\.me\//i,              // Telegram links
  /twitch\.tv\//i,         // Twitch self-promo
  /\.com\/|\.net\/|\.gg\//i, // Generic domain links
];

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const POOL_MAX = 100;
const RESPONSE_MIN_MS = 2 * 60 * 1000;  // 2 minutes
const RESPONSE_MAX_MS = 5 * 60 * 1000;  // 5 minutes
const USER_RESPONSE_COOLDOWN_MS = 10 * 60 * 1000;

// ── Service ────────────────────────────────────────────────────────────────────

class YouTubeChatService {
  private apiKey = '';
  private liveChatId = '';
  private nextPageToken = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private messagePool: PoolMessage[] = [];
  private seenIds = new Set<string>();
  private sseClients = new Set<SSEClient>();
  private colorMap = new Map<string, string>();
  private colorIdx = 0;
  private recentResponseAuthors = new Map<string, number>();
  private recentResponseTexts: string[] = [];
  private _responseHandler: ((user: string, text: string) => Promise<string>) | null = null;
  private _responding = false;
  private _configured = false;
  private _lastQuotaErrorAt = 0;

  /** Auto-configure from environment variables on startup. */
  initFromEnv(): void {
    const apiKey = process.env.YOUTUBE_API_KEY || '';
    const liveChatId = process.env.YOUTUBE_LIVE_CHAT_ID || '';
    if (apiKey && liveChatId) {
      console.log('[YouTube Chat] Auto-configuring from environment variables');
      this.configure(apiKey, liveChatId);
    } else {
      console.log('[YouTube Chat] No env config — waiting for POST /api/chat/config');
    }
  }

  /** Configure and start polling. Can be called at runtime to update credentials. */
  configure(apiKey: string, liveChatId: string): void {
    this.stop();

    this.apiKey = apiKey;
    this.liveChatId = liveChatId;
    this.nextPageToken = '';
    this._configured = !!(apiKey && liveChatId);

    if (this._configured) {
      this.start();
    } else {
      console.log('[YouTube Chat] Configuration cleared / incomplete — polling stopped');
    }
  }

  private start(): void {
    this.scheduleNextPoll(0); // immediate first poll
    this.scheduleNextResponse();
    console.log('[YouTube Chat] Polling started');
  }

  private scheduleNextPoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => this.pollAndReschedule(), delayMs) as unknown as ReturnType<typeof setInterval>;
  }

  private async pollAndReschedule(): Promise<void> {
    if (!this._configured) return;
    const nextMs = await this.poll();
    if (this._configured) this.scheduleNextPoll(nextMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer as unknown as ReturnType<typeof setTimeout>);
      this.pollTimer = null;
    }
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }

  // ── SSE client management ────────────────────────────────────────────────────

  addClient(client: SSEClient): void {
    this.sseClients.add(client);
  }

  removeClient(client: SSEClient): void {
    this.sseClients.delete(client);
  }

  private broadcast(data: object): void {
    for (const client of this.sseClients) {
      try {
        client(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  /** Returns the delay (ms) to wait before the next poll. */
  private async poll(): Promise<number> {
    const DEFAULT_INTERVAL = 240_000;
    const MIN_INTERVAL = 240_000;  // 240s — keep daily quota under 1,800 units (was 120s = 3,600 units)
    const MAX_INTERVAL = 300_000;

    if (!this.apiKey || !this.liveChatId) return DEFAULT_INTERVAL;

    try {
      const params = new URLSearchParams({
        liveChatId: this.liveChatId,
        part: 'snippet,authorDetails',
        key: this.apiKey,
        maxResults: '200',
      });
      if (this.nextPageToken) {
        params.set('pageToken', this.nextPageToken);
      }

      const res = await fetch(`${YT_API_BASE}/liveChatMessages?${params}`);

      if (!res.ok) {
        const body = await res.text();
        console.error(`[YouTube Chat] API error ${res.status}: ${body.slice(0, 200)}`);
        if (res.status === 403 && /quota/i.test(body)) {
          this._lastQuotaErrorAt = Date.now();
        }
        return DEFAULT_INTERVAL;
      }

      this._lastQuotaErrorAt = 0;
      const data = await res.json() as {
        nextPageToken?: string;
        pollingIntervalMillis?: number;
        items?: Array<{
          id: string;
          snippet: { displayMessage: string };
          authorDetails: { displayName: string; channelId: string };
        }>;
      };

      this.nextPageToken = data.nextPageToken ?? '';

      for (const item of data.items ?? []) {
        if (this.seenIds.has(item.id)) continue;
        this.seenIds.add(item.id);

        const text = item.snippet?.displayMessage ?? '';
        const user = item.authorDetails?.displayName ?? 'viewer';
        const channelId = item.authorDetails?.channelId ?? item.id;

        // Record poll vote (before filter — single-letter votes must always register)
        pollManager.recordVote(user, text);

        opsMemory.noteViewer(user);
        if (/\b(song|track|play|id|name|request)\b/i.test(text)) {
          opsMemory.addRequest(user, text);
        }
        const moderationReason = chatOrchestrator.considerFlag(user, text);
        if (moderationReason) {
          console.warn(`[YouTube Chat] Flagged message from ${user}: ${moderationReason}`);
        }

        if (!this.passesFilter(text)) continue;

        const color = this.assignColor(channelId);

        // Broadcast to all connected browsers
        this.broadcast({
          type: 'chat',
          message: { user, text, isAI: false, color },
        });

        // Add to response pool
        this.messagePool.push({ id: item.id, user, authorChannelId: channelId, text, color });
        if (this.messagePool.length > POOL_MAX) this.messagePool.shift();
      }

      // Keep seenIds from growing indefinitely
      if (this.seenIds.size > 5000) {
        const arr = [...this.seenIds];
        this.seenIds.clear();
        for (const id of arr.slice(-2000)) this.seenIds.add(id);
      }

      // Prune colorMap to prevent unbounded growth on long streams
      if (this.colorMap.size > 10_000) {
        const entries = [...this.colorMap.entries()].slice(-5_000);
        this.colorMap = new Map(entries);
      }

      // Prune recentResponseAuthors — remove entries older than the cooldown window
      if (this.recentResponseAuthors.size > 1_000) {
        const cutoff = Date.now() - USER_RESPONSE_COOLDOWN_MS;
        for (const [id, ts] of this.recentResponseAuthors) {
          if (ts < cutoff) this.recentResponseAuthors.delete(id);
        }
      }

      // Use the API's recommended polling interval, clamped to safe bounds
      const suggested = data.pollingIntervalMillis ?? DEFAULT_INTERVAL;
      return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, suggested));

    } catch (err) {
      console.error('[YouTube Chat] Poll error:', err);
      return DEFAULT_INTERVAL;
    }
  }

  // ── Filter ───────────────────────────────────────────────────────────────────

  private passesFilter(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    if (normalized.length > 280) return false;
    if (/^[\p{Emoji}\p{P}\p{S}\s]+$/u.test(normalized)) return false;
    if (/^(hi|hey|yo|sup|first|lol|lmao|nice|cool|🔥|❤|❤️)$/iu.test(normalized)) return false;
    if (/(.)\1{8,}/u.test(normalized)) return false;
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(normalized)) return false;
    }
    return true;
  }

  // ── Color assignment ─────────────────────────────────────────────────────────

  private assignColor(channelId: string): string {
    if (!this.colorMap.has(channelId)) {
      this.colorMap.set(channelId, USER_COLORS[this.colorIdx % USER_COLORS.length]);
      this.colorIdx++;
    }
    return this.colorMap.get(channelId)!;
  }

  // ── AI response generation ───────────────────────────────────────────────────

  private scheduleNextResponse(): void {
    const delay = RESPONSE_MIN_MS + Math.random() * (RESPONSE_MAX_MS - RESPONSE_MIN_MS);
    this.responseTimer = setTimeout(() => {
      this.generateResponse().finally(() => this.scheduleNextResponse());
    }, delay);
  }

  /**
   * Register an AI response handler. Called with (user, message) — should return
   * Flow's response text. Wire this up via LLM Gateway when ready.
   * Falls back to generic lines if no handler is registered.
   */
  setResponseHandler(fn: (user: string, text: string) => Promise<string>): void {
    this._responseHandler = fn;
  }

  private async generateResponse(): Promise<void> {
    if (this._responding) return;
    this._responding = true;
    try {
      if (this.messagePool.length === 0) {
        if (chatOrchestrator.shouldSendPresence(this.messagePool.length)) {
          const presenceText = 'still here. still mixing. what do you want to hear next?';
          this.broadcast({
            type: 'chat',
            message: { user: 'Flow', text: presenceText, isAI: true, color: '' },
          });
        }
        return;
      }

      const now = Date.now();
      const candidates = this.messagePool.filter((msg) => {
        const lastReplyAt = this.recentResponseAuthors.get(msg.authorChannelId) ?? 0;
        return now - lastReplyAt >= USER_RESPONSE_COOLDOWN_MS;
      });

      const source = candidates.length > 0 ? candidates : this.messagePool;
      const priority = source.filter((msg) => /\?|\b(flow|song|track|id|name|who|what|when|why|how|play)\b/i.test(msg.text));
      const msg = (priority.length > 0 ? priority : source)[Math.floor(Math.random() * (priority.length > 0 ? priority.length : source.length))];
      let responseText = '';

      if (this._responseHandler) {
        try {
          responseText = await this._responseHandler(msg.user, msg.text);
        } catch (err) {
          console.error('[YouTube Chat] Response handler error:', err);
        }
      }

      // Fallback if no handler registered or handler errored
      if (!responseText) {
        const fallbacks = [
          'Feeling the energy tonight.',
          "Chat is alive — that's what I like.",
          'Appreciate you all being here.',
          'This set is just getting started.',
          'The music speaks for itself.',
        ];
        responseText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }

      if (this.recentResponseTexts.includes(responseText)) {
        return;
      }

      this.recentResponseAuthors.set(msg.authorChannelId, now);
      this.recentResponseTexts.push(responseText);
      if (this.recentResponseTexts.length > 20) this.recentResponseTexts.shift();

      this.broadcast({
        type: 'chat',
        message: { user: 'Flow', text: responseText, isAI: true, color: '' },
      });

      console.log(`[YouTube Chat] Flow responded to ${msg.user}: "${responseText}"`);
    } finally {
      this._responding = false;
    }
  }

  // ── Chat outbound (POST to YouTube live chat) ─────────────────────────────────

  private _lastChatSentAt = 0;
  private readonly _chatRateLimitMs = 20_000; // max 1 message per 20s

  /**
   * Post a message to the YouTube live chat as the channel owner.
   * Requires OAuth token with youtube scope (already set up for broadcast management).
   * Returns false if not live, not authorized, or rate-limited.
   */
  async sendChatMessage(text: string): Promise<boolean> {
    if (!this.liveChatId) return false;
    if (!youtubeAuthService.isAuthorized) return false;

    const now = Date.now();
    if (now - this._lastChatSentAt < this._chatRateLimitMs) return false;

    try {
      const token = await youtubeAuthService.getAccessToken();
      const res = await fetch(
        'https://www.googleapis.com/youtube/v3/liveChatMessages?part=snippet',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: {
              liveChatId: this.liveChatId,
              type: 'textMessageEvent',
              textMessageDetails: { messageText: text.slice(0, 200) },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(`[YouTube Chat] sendChatMessage error ${res.status}: ${body.slice(0, 200)}`);
        return false;
      }

      this._lastChatSentAt = now;
      return true;
    } catch (err) {
      console.error('[YouTube Chat] sendChatMessage failed:', (err as Error).message);
      return false;
    }
  }

  // ── Mood analysis ─────────────────────────────────────────────────────────────

  private readonly _moodKeywords = {
    high:  ['fire', 'hard', 'banger', 'go off', 'harder', 'louder', '🔥', '💯', 'lit'],
    chill: ['vibes', 'chill', 'studying', 'studying', 'calm', 'relax', 'smooth', '😌'],
    request: ['play', 'drop', 'request', 'can you', 'next'],
  };

  getChatMood(): { energy: 'high' | 'neutral' | 'chill'; topRequestedGenre: string | null; sampleSize: number; updatedAt: number } {
    const recent = this.messagePool.slice(-50);
    let highCount = 0, chillCount = 0;
    const genreMentions: Record<string, number> = {};
    const knownGenres = ['drill', 'grime', 'afro', 'hip hop', 'hip-hop', 'lo-fi', 'lofi', 'amapiano', 'reggae', 'trap'];

    for (const msg of recent) {
      const lower = msg.text.toLowerCase();
      if (this._moodKeywords.high.some(k => lower.includes(k))) highCount++;
      if (this._moodKeywords.chill.some(k => lower.includes(k))) chillCount++;
      for (const g of knownGenres) {
        if (lower.includes(g)) genreMentions[g] = (genreMentions[g] ?? 0) + 1;
      }
    }

    const energy: 'high' | 'neutral' | 'chill' =
      highCount > chillCount * 2 ? 'high' :
      chillCount > highCount * 2 ? 'chill' : 'neutral';

    const topGenreEntry = Object.entries(genreMentions).sort((a, b) => b[1] - a[1])[0];
    const topRequestedGenre = topGenreEntry ? topGenreEntry[0] : null;

    return { energy, topRequestedGenre, sampleSize: recent.length, updatedAt: Date.now() };
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  get isConfigured(): boolean {
    return this._configured;
  }

  get poolSize(): number {
    return this.messagePool.length;
  }

  get clientCount(): number {
    return this.sseClients.size;
  }

  get lastQuotaErrorAt(): number {
    return this._lastQuotaErrorAt;
  }

  get liveChatIdValue(): string {
    return this.liveChatId;
  }
}

export const youtubeChatService = new YouTubeChatService();
