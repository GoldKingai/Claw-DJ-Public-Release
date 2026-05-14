/**
 * YouTube Metrics Service
 *
 * Polls the YouTube Data API v3 for live stream viewer count and channel
 * subscriber count, then pushes updates to SSE clients.
 *
 * Endpoints used:
 *   videos.list?part=liveStreamingDetails&id=VIDEO_ID
 *     → liveStreamingDetails.concurrentViewers
 *     → liveStreamingDetails.likeCount (if available)
 *
 *   channels.list?part=statistics&id=CHANNEL_ID
 *     → statistics.subscriberCount
 *
 * videoId is derived from the liveChatId (first 11 chars after "LC" prefix
 * are NOT the video ID — we store it separately when configured).
 *
 * Config:
 *   configure(apiKey, videoId, channelId) — called at runtime or from env
 *   initFromEnv()                          — reads YOUTUBE_* env vars
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  viewers: number;
  peakViewers: number;
  subscribers: number;
  likes: number;
  updatedAt: number; // ms since epoch
}

type SSEClient = (data: object) => void;

// ── Constants ──────────────────────────────────────────────────────────────────

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const POLL_INTERVAL_MS = 60_000; // 60 seconds — YouTube quota friendly

// ── Service ────────────────────────────────────────────────────────────────────

class YouTubeMetricsService {
  private apiKey = '';
  private videoId = '';
  private channelId = '';

  private _configured = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentPollIntervalMs = POLL_INTERVAL_MS;
  private _lastQuotaErrorAt = 0;
  private _lastSubscriberPollAt = 0;
  private static readonly SUBSCRIBER_POLL_INTERVAL_MS = 10 * 60_000; // 10 minutes
  private sseClients = new Set<SSEClient>();

  private _snapshot: MetricsSnapshot = {
    viewers: 0,
    peakViewers: 0,
    subscribers: 0,
    likes: 0,
    updatedAt: 0,
  };

  // ── Init ────────────────────────────────────────────────────────────────────

  initFromEnv(): void {
    const apiKey = process.env.YOUTUBE_API_KEY || '';
    const videoId = process.env.YOUTUBE_VIDEO_ID || '';
    const channelId = process.env.YOUTUBE_CHANNEL_ID || '';

    if (apiKey && videoId && channelId) {
      console.log('[YouTube Metrics] Auto-configuring from environment variables');
      this.configure(apiKey, videoId, channelId);
    } else {
      console.log(
        '[YouTube Metrics] Partial or missing env config — waiting for POST /api/metrics/config'
      );
    }
  }

  configure(apiKey: string, videoId: string, channelId: string): void {
    this.stop();
    this.apiKey = apiKey;
    this.videoId = videoId;
    this.channelId = channelId;
    this._configured = !!(apiKey && (videoId || channelId));
    this.currentPollIntervalMs = POLL_INTERVAL_MS;
    this._lastQuotaErrorAt = 0;

    if (this._configured) {
      this.poll(); // immediate first fetch
      this._armPolling(this.currentPollIntervalMs);
      console.log('[YouTube Metrics] Polling started');
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private _armPolling(intervalMs: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.currentPollIntervalMs = intervalMs;
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  // ── SSE client management ────────────────────────────────────────────────────

  addClient(client: SSEClient): void {
    this.sseClients.add(client);
    // Send current snapshot immediately so the new client doesn't wait 60s
    if (this._snapshot.updatedAt > 0) {
      client({ type: 'metrics', data: this._snapshot });
    }
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

  private async poll(): Promise<void> {
    if (!this.apiKey) return;

    let viewers = this._snapshot.viewers;
    let likes = this._snapshot.likes;
    let subscribers = this._snapshot.subscribers;

    // ── Concurrent viewers + likes ────────────────────────────────────────────
    if (this.videoId) {
      try {
        const params = new URLSearchParams({
          part: 'liveStreamingDetails,statistics',
          id: this.videoId,
          key: this.apiKey,
        });
        const res = await fetch(`${YT_API_BASE}/videos?${params}`);

        if (res.ok) {
          this._lastQuotaErrorAt = 0;
          if (this.currentPollIntervalMs !== POLL_INTERVAL_MS) this._armPolling(POLL_INTERVAL_MS);
          const body = await res.json() as {
            items?: Array<{
              liveStreamingDetails?: {
                concurrentViewers?: string;
              };
              statistics?: {
                likeCount?: string;
              };
            }>;
          };

          const item = body.items?.[0];
          if (item) {
            const cv = parseInt(item.liveStreamingDetails?.concurrentViewers ?? '0', 10);
            if (!isNaN(cv)) viewers = cv;

            const lc = parseInt(item.statistics?.likeCount ?? '0', 10);
            if (!isNaN(lc)) likes = lc;
          }
        } else {
          const errText = await res.text();
          console.error(`[YouTube Metrics] videos.list error ${res.status}: ${errText.slice(0, 200)}`);
          if (res.status === 403 && /quota/i.test(errText)) {
            this._lastQuotaErrorAt = Date.now();
            this._armPolling(10 * 60_000);
            console.warn('[YouTube Metrics] Quota hit — backing off to 10 min polling');
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
          if (this.currentPollIntervalMs < 5 * 60_000) {
            this._armPolling(5 * 60_000);
            console.warn('[YouTube Metrics] Network unreachable — backing off to 5 min');
          }
        } else {
          console.error('[YouTube Metrics] videos.list fetch error:', err);
        }
      }
    }

    // ── Subscriber count — polled every 10 min (changes slowly) ──────────────
    const now = Date.now();
    if (this.channelId && now - this._lastSubscriberPollAt >= YouTubeMetricsService.SUBSCRIBER_POLL_INTERVAL_MS) {
      this._lastSubscriberPollAt = now;
      try {
        const params = new URLSearchParams({
          part: 'statistics',
          id: this.channelId,
          key: this.apiKey,
        });
        const res = await fetch(`${YT_API_BASE}/channels?${params}`);

        if (res.ok) {
          this._lastQuotaErrorAt = 0;
          if (this.currentPollIntervalMs !== POLL_INTERVAL_MS) this._armPolling(POLL_INTERVAL_MS);
          const body = await res.json() as {
            items?: Array<{
              statistics?: { subscriberCount?: string };
            }>;
          };

          const sc = parseInt(body.items?.[0]?.statistics?.subscriberCount ?? '0', 10);
          if (!isNaN(sc) && sc > 0) subscribers = sc;
        } else {
          const errText = await res.text();
          console.error(`[YouTube Metrics] channels.list error ${res.status}: ${errText.slice(0, 200)}`);
          if (res.status === 403 && /quota/i.test(errText)) {
            this._lastQuotaErrorAt = Date.now();
            this._armPolling(10 * 60_000);
            console.warn('[YouTube Metrics] Quota hit — backing off to 10 min polling');
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
          console.error('[YouTube Metrics] channels.list fetch error:', err);
        }
      }
    }

    // ── Update snapshot and broadcast ─────────────────────────────────────────
    this._snapshot = {
      viewers,
      peakViewers: Math.max(this._snapshot.peakViewers, viewers),
      subscribers,
      likes,
      updatedAt: Date.now(),
    };

    this.broadcast({ type: 'metrics', data: this._snapshot });
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  get isConfigured(): boolean {
    return this._configured;
  }

  get snapshot(): MetricsSnapshot {
    return this._snapshot;
  }

  get clientCount(): number {
    return this.sseClients.size;
  }

  get lastQuotaErrorAt(): number {
    return this._lastQuotaErrorAt;
  }
}

export const youtubeMetricsService = new YouTubeMetricsService();
