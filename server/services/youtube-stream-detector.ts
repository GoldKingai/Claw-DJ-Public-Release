/**
 * YouTube Stream Detector
 *
 * Polls `search.list?eventType=live&channelId=...` every 60 s.
 * When an active live stream is detected it auto-fetches the Video ID and
 * `activeLiveChatId`, then configures `youtubeChatService` and
 * `youtubeMetricsService` without any human input.
 *
 * Requires only two permanent values (set once via env or Settings):
 *   YOUTUBE_API_KEY
 *   YOUTUBE_CHANNEL_ID
 *
 * All per-broadcast IDs (Video ID, Live Chat ID) are discovered automatically.
 */

import { youtubeChatService } from './youtube-chat.js';
import { youtubeMetricsService } from './youtube-metrics.js';
import { opsMemory } from './ops-memory.js';
import { youtubeAuthService } from './youtube-auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const POLL_INTERVAL_MS        = 60_000;           // 60 s — when live
const IDLE_POLL_INTERVAL_MS   = 30 * 60_000;      // 30 min — not streaming
const STARTUP_RETRY_INTERVAL  = 60_000;            // 1 min — fast retry window at startup
const STARTUP_RETRY_WINDOW_MS = 10 * 60_000;      // try every 1 min for 10 min after configure

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamStatus {
  isLive: boolean;
  videoId: string;
  liveChatId: string;
  detectedAt: number; // ms epoch, 0 if not live
}

// ── Service ───────────────────────────────────────────────────────────────────

class YouTubeStreamDetectorService {
  private apiKey = '';
  private channelId = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentPollIntervalMs = POLL_INTERVAL_MS;
  private _lastQuotaErrorAt = 0;
  private _cachedVideoId = ''; // cache after first search.list — reuse with videos.list (1 unit)
  private _startupRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private _status: StreamStatus = {
    isLive: false,
    videoId: '',
    liveChatId: '',
    detectedAt: 0,
  };

  // ── Init ────────────────────────────────────────────────────────────────────

  initFromEnv(): void {
    const apiKey = process.env.YOUTUBE_API_KEY || '';
    const channelId = process.env.YOUTUBE_CHANNEL_ID || '';

    if (apiKey && channelId) {
      console.log('[Stream Detector] Auto-configuring from environment variables');
      this.configure(apiKey, channelId);
    } else {
      console.log(
        '[Stream Detector] Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID — waiting for POST /api/stream/config'
      );
    }
  }

  configure(apiKey: string, channelId: string): void {
    this.stop();
    this.apiKey = apiKey;
    this.channelId = channelId;
    this.currentPollIntervalMs = POLL_INTERVAL_MS;
    this._lastQuotaErrorAt = 0;

    if (apiKey && channelId) {
      // Immediate first check
      this.poll();
      // Startup retry burst: poll every 1 min for 10 min in case stream wasn’t live yet
      this._startupRetryTimer = setTimeout(() => {
        this._startupRetryTimer = null;
        // Only arm idle polling if stream still not found
        if (!this._status.isLive) {
          this._armPolling(IDLE_POLL_INTERVAL_MS);
          console.log(`[Stream Detector] Startup retry window ended — switching to 30 min idle heartbeat`);
        }
      }, STARTUP_RETRY_WINDOW_MS);
      this._armPolling(STARTUP_RETRY_INTERVAL);
      console.log(`[Stream Detector] Startup retry active for channel ${channelId} (1 min checks for 10 min, then 30 min idle)`);
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._startupRetryTimer) {
      clearTimeout(this._startupRetryTimer);
      this._startupRetryTimer = null;
    }
  }

  private _armPolling(intervalMs: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.currentPollIntervalMs = intervalMs;
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.apiKey || !this.channelId) return;

    try {
      let videoId = '';
      let liveChatId = '';

      if (youtubeAuthService.isAuthorized) {
        // OAuth path — liveBroadcasts.list costs 1 unit (vs search.list at 100 units)
        // and returns the liveChatId directly, so no second API call needed.
        let accessToken: string;
        try {
          accessToken = await youtubeAuthService.getAccessToken();
        } catch (err) {
          console.warn('[Stream Detector] OAuth token unavailable, falling back to search.list:', err);
          return this._pollWithApiKey();
        }

        // Use mine=true only (broadcastStatus cannot be combined with mine per API spec)
        // Filter for live status client-side via snippet.liveChatId presence
        const params = new URLSearchParams({
          part: 'id,snippet,status',
          mine: 'true',
          maxResults: '10',
        });
        const res = await fetch(`${YT_API_BASE}/liveBroadcasts?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`[Stream Detector] liveBroadcasts.list error ${res.status}: ${errText.slice(0, 200)}`);
          if (res.status === 403 && /quota/i.test(errText)) {
            this._lastQuotaErrorAt = Date.now();
            this._armPolling(10 * 60_000);
            console.warn('[Stream Detector] Quota hit — backing off to 10 min polling');
            opsMemory.addIncident('youtube_quota', 'stream detector quota backoff');
          }
          this._markOffline();
          return;
        }

        this._lastQuotaErrorAt = 0;

        const body = (await res.json()) as {
          items?: Array<{
            id?: string;
            snippet?: { liveChatId?: string };
            status?: { lifeCycleStatus?: string; recordingStatus?: string };
          }>;
        };

        // Find the first broadcast that is currently live
        const liveBroadcast = body.items?.find(
          (b) => b.status?.lifeCycleStatus === 'live' || b.status?.recordingStatus === 'recording'
        );

        videoId = liveBroadcast?.id ?? '';
        // snippet.liveChatId is a partial ID — always resolve via videos.list below
      } else {
        // API key fallback — more expensive but works without OAuth
        return this._pollWithApiKey();
      }

      if (!videoId) {
        if (this._status.isLive) console.log('[Stream Detector] Stream ended — resetting');
        this._markOffline();
        return;
      }

      // Always get activeLiveChatId from videos.list — liveBroadcasts snippet.liveChatId
      // is a truncated form that causes 404 on liveChatMessages.list
      try {
        const vParams = new URLSearchParams({ part: 'liveStreamingDetails', id: videoId, key: this.apiKey });
        const vRes = await fetch(`${YT_API_BASE}/videos?${vParams}`);
        if (vRes.ok) {
          const vBody = await vRes.json() as {
            items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }>;
          };
          liveChatId = vBody.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? '';
        }
      } catch { /* proceed without chat if lookup fails */ }

      this._configureDownstream(videoId, liveChatId);
    } catch (err) {
      console.error('[Stream Detector] Poll error:', err);
    }
  }

  /** Fallback poll using search.list (100 units). Used when OAuth is not configured. */
  private async _pollWithApiKey(): Promise<void> {
    try {
      // Fast path: we already know the videoId -- use videos.list (1 unit)
      if (this._cachedVideoId) {
        const fParams = new URLSearchParams({
          part: 'snippet,liveStreamingDetails',
          id: this._cachedVideoId,
          key: this.apiKey,
        });
        const fRes = await fetch(`${YT_API_BASE}/videos?${fParams}`);
        if (fRes.ok) {
          const fBody = await fRes.json() as {
            items?: Array<{
              snippet?: { liveBroadcastContent?: string };
              liveStreamingDetails?: { activeLiveChatId?: string };
            }>;
          };
          const item = fBody.items?.[0];
          if (item?.snippet?.liveBroadcastContent === 'live') {
            const chatId = item.liveStreamingDetails?.activeLiveChatId ?? '';
            console.log('[Stream Detector] Fast-path: still live, videoId=' + this._cachedVideoId);
            this._configureDownstream(this._cachedVideoId, chatId);
            return;
          } else {
            console.log('[Stream Detector] Fast-path: stream ended -- clearing cache');
            this._cachedVideoId = '';
            this._markOffline();
            return;
          }
        }
        // Fetch error -- fall through to slow path
        this._cachedVideoId = '';
      }

      // Slow path: no cached videoId -- use search.list (100 units)
      const searchParams = new URLSearchParams({
        part: 'id',
        channelId: this.channelId,
        eventType: 'live',
        type: 'video',
        key: this.apiKey,
      });
      const searchRes = await fetch(`${YT_API_BASE}/search?${searchParams}`);

      if (!searchRes.ok) {
        const errText = await searchRes.text();
        console.error(`[Stream Detector] search.list error ${searchRes.status}: ${errText.slice(0, 200)}`);
        if (searchRes.status === 403 && /quota/i.test(errText)) {
          this._lastQuotaErrorAt = Date.now();
          this._armPolling(10 * 60_000);
          console.warn('[Stream Detector] Quota hit — backing off to 10 min polling');
          opsMemory.addIncident('youtube_quota', 'stream detector quota backoff');
        }
        this._markOffline();
        return;
      }

      this._lastQuotaErrorAt = 0;

      const searchBody = (await searchRes.json()) as {
        items?: Array<{ id?: { videoId?: string } }>;
      };
      const videoId = searchBody.items?.[0]?.id?.videoId ?? '';

      if (!videoId) {
        if (this._status.isLive) console.log('[Stream Detector] Stream ended — resetting');
        this._markOffline();
        return;
      }

      const videoParams = new URLSearchParams({
        part: 'liveStreamingDetails',
        id: videoId,
        key: this.apiKey,
      });
      const videoRes = await fetch(`${YT_API_BASE}/videos?${videoParams}`);
      if (!videoRes.ok) return;

      const videoBody = (await videoRes.json()) as {
        items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }>;
      };
      const liveChatId = videoBody.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? '';

      this._cachedVideoId = videoId;  // cache for fast-path on next poll
      this._configureDownstream(videoId, liveChatId);
    } catch (err) {
      console.error('[Stream Detector] API key poll error:', err);
    }
  }

  private _configureDownstream(videoId: string, liveChatId: string): void {
    const alreadyConfigured =
      this._status.isLive &&
      this._status.videoId === videoId &&
      this._status.liveChatId === liveChatId;

    if (!alreadyConfigured) {
      console.log(`[Stream Detector] Live stream detected — videoId=${videoId} liveChatId=${liveChatId || '(none)'}`);

      this._status = { isLive: true, videoId, liveChatId, detectedAt: Date.now() };
      // Cancel startup retry window — stream found
      if (this._startupRetryTimer) { clearTimeout(this._startupRetryTimer); this._startupRetryTimer = null; }

      // Switch to fast poll now that we're live
      this._armPolling(POLL_INTERVAL_MS);

      // Start metrics and chat — these do nothing until now
      youtubeMetricsService.configure(this.apiKey, videoId, this.channelId);

      if (liveChatId) {
        youtubeChatService.configure(this.apiKey, liveChatId);
      } else {
        console.warn('[Stream Detector] No activeLiveChatId — chat polling skipped');
      }
    }
  }

  private _markOffline(): void {
    if (this._status.isLive) {
      // Stream ended — stop all metric/chat polling, return to slow idle heartbeat
      youtubeMetricsService.stop();
      youtubeChatService.stop();
      this._armPolling(IDLE_POLL_INTERVAL_MS);
      console.log('[Stream Detector] Stream ended — metrics/chat stopped, idle heartbeat (5 min)');
    }
    this._cachedVideoId = '';
    this._status = { isLive: false, videoId: '', liveChatId: '', detectedAt: 0 };
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  get status(): StreamStatus {
    return this._status;
  }

  get isConfigured(): boolean {
    return !!(this.apiKey && this.channelId);
  }

  get lastQuotaErrorAt(): number {
    return this._lastQuotaErrorAt;
  }
}

export const youtubeStreamDetector = new YouTubeStreamDetectorService();
