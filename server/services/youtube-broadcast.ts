/**
 * YouTube Broadcast Service
 *
 * Manages the full YouTube live broadcast lifecycle via YouTube Data API v3.
 * Requires OAuth2 authorization (handled by youtube-auth.ts).
 *
 * Flow:
 *   1. createBroadcast()   — creates the LiveBroadcast resource
 *   2. createStream()      — creates the LiveStream (ingestion endpoint)
 *   3. bind()              — binds broadcast ↔ stream
 *   4. goLive()            — transitions broadcast to "live"
 *   5. endStream()         — transitions broadcast to "complete"
 *
 * OBS side:
 *   OBS connects to the RTMP ingestion URL from createStream().
 *   Once OBS is streaming and the stream health is "good", goLive() works.
 *
 * Scopes required:
 *   https://www.googleapis.com/auth/youtube
 */

import { youtubeAuthService } from './youtube-auth.js';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BroadcastInfo {
  broadcastId: string;
  streamId: string;
  rtmpUrl: string;     // RTMP ingestion URL (for OBS)
  streamKey: string;   // RTMP stream key (for OBS)
  status: BroadcastLifecycleStatus;
  createdAt: number;   // ms epoch
}

export type BroadcastLifecycleStatus =
  | 'idle'
  | 'creating'
  | 'ready'        // broadcast + stream created, OBS can connect
  | 'live'         // broadcast is live on YouTube
  | 'ending'
  | 'complete'
  | 'error';

// ── Service ───────────────────────────────────────────────────────────────────

class YouTubeBroadcastService {
  private _info: BroadcastInfo = {
    broadcastId: '',
    streamId: '',
    rtmpUrl: '',
    streamKey: '',
    status: 'idle',
    createdAt: 0,
  };

  // ── Status ───────────────────────────────────────────────────────────────────

  get info(): BroadcastInfo {
    return { ...this._info };
  }

  get isReady(): boolean {
    return this._info.status === 'ready';
  }

  get isLive(): boolean {
    return this._info.status === 'live';
  }

  // ── Create broadcast + stream ─────────────────────────────────────────────────

  async createBroadcast(
    title: string,
    description = '',
    scheduledStartTime?: string // ISO8601, defaults to now + 1 min
  ): Promise<BroadcastInfo> {
    this._setStatus('creating');

    const token = await youtubeAuthService.getAccessToken();

    const startTime =
      scheduledStartTime ??
      new Date(Date.now() + 60_000).toISOString(); // 1 min from now

    // Step 1 — create broadcast
    const broadcastRes = await fetch(`${YT_API_BASE}/liveBroadcasts?part=id,snippet,status,contentDetails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          scheduledStartTime: startTime,
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: false,
          enableAutoStop: false,
          enableDvr: true,
          recordFromStart: true,
          monitorStream: {
            enableMonitorStream: false,
          },
        },
      }),
    });

    if (!broadcastRes.ok) {
      const err = await broadcastRes.text();
      this._setStatus('error');
      throw new Error(`liveBroadcasts.insert failed (${broadcastRes.status}): ${err.slice(0, 400)}`);
    }

    const broadcast = (await broadcastRes.json()) as { id: string };
    const broadcastId = broadcast.id;
    console.log(`[Broadcast] Created broadcast — id=${broadcastId}`);

    // Step 2 — create live stream
    const streamRes = await fetch(`${YT_API_BASE}/liveStreams?part=id,snippet,cdn,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: { title: `${title} — stream` },
        cdn: {
          frameRate: '60fps',
          ingestionType: 'rtmp',
          resolution: '1080p',
        },
      }),
    });

    if (!streamRes.ok) {
      const err = await streamRes.text();
      this._setStatus('error');
      throw new Error(`liveStreams.insert failed (${streamRes.status}): ${err.slice(0, 400)}`);
    }

    const stream = (await streamRes.json()) as {
      id: string;
      cdn: { ingestionInfo: { ingestionAddress: string; streamName: string } };
    };

    const streamId   = stream.id;
    const rtmpUrl    = stream.cdn.ingestionInfo.ingestionAddress;
    const streamKey  = stream.cdn.ingestionInfo.streamName;
    console.log(`[Broadcast] Created live stream — id=${streamId} rtmp=${rtmpUrl}`);

    // Step 3 — bind broadcast to stream
    const bindParams = new URLSearchParams({
      id: broadcastId,
      part: 'id,contentDetails',
      streamId,
    });

    const bindRes = await fetch(`${YT_API_BASE}/liveBroadcasts/bind?${bindParams}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!bindRes.ok) {
      const err = await bindRes.text();
      this._setStatus('error');
      throw new Error(`liveBroadcasts.bind failed (${bindRes.status}): ${err.slice(0, 400)}`);
    }

    console.log('[Broadcast] Bound broadcast to stream');

    this._info = {
      broadcastId,
      streamId,
      rtmpUrl,
      streamKey,
      status: 'ready',
      createdAt: Date.now(),
    };

    return this.info;
  }

  // ── Go live ───────────────────────────────────────────────────────────────────

  /**
   * Transitions the broadcast from "testing" / "ready" → "live".
   * OBS must already be streaming to the RTMP endpoint and YouTube must show
   * stream health as "good" or "ok" before this will succeed.
   */
  async goLive(): Promise<void> {
    if (!this._info.broadcastId) {
      throw new Error('No broadcast — call createBroadcast() first');
    }

    const token = await youtubeAuthService.getAccessToken();

    await this._transition('live', token);
    this._setStatus('live');
    console.log('[Broadcast] Broadcast is now LIVE');
  }

  // ── End stream ────────────────────────────────────────────────────────────────

  async endStream(): Promise<void> {
    if (!this._info.broadcastId) {
      throw new Error('No active broadcast');
    }

    this._setStatus('ending');
    const token = await youtubeAuthService.getAccessToken();

    await this._transition('complete', token);
    this._setStatus('complete');
    console.log('[Broadcast] Broadcast ended — status: complete');

    // Clear IDs so a new broadcast can be created next session
    setTimeout(() => {
      this._info = {
        broadcastId: '',
        streamId: '',
        rtmpUrl: '',
        streamKey: '',
        status: 'idle',
        createdAt: 0,
      };
    }, 5_000);
  }

  // ── Update broadcast title ────────────────────────────────────────────────────

  /**
   * Update the title of the current broadcast in-place.
   * No-op if no active broadcast. Silently swallows errors (non-critical).
   */
  async updateTitle(title: string): Promise<void> {
    if (!this._info.broadcastId) return;

    const token = await youtubeAuthService.getAccessToken().catch(() => null);
    if (!token) return;

    // Fetch current snippet to preserve scheduledStartTime (required for update)
    const getRes = await fetch(
      `${YT_API_BASE}/liveBroadcasts?part=snippet&id=${this._info.broadcastId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => null);
    if (!getRes?.ok) return;

    const body = (await getRes.json()) as {
      items?: Array<{ snippet?: { scheduledStartTime?: string; description?: string } }>;
    };
    const snippet = body.items?.[0]?.snippet;
    if (!snippet) return;

    await fetch(`${YT_API_BASE}/liveBroadcasts?part=snippet`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: this._info.broadcastId,
        snippet: {
          title: title.slice(0, 100),
          scheduledStartTime: snippet.scheduledStartTime ?? new Date().toISOString(),
          description: snippet.description ?? '',
        },
      }),
    }).catch(err => console.warn('[Broadcast] updateTitle failed:', err));

    console.log(`[Broadcast] Title updated → "${title}"`);
  }

  // ── Delete broadcast (cleanup) ────────────────────────────────────────────────

  async deleteBroadcast(): Promise<void> {
    if (!this._info.broadcastId) return;

    const token = await youtubeAuthService.getAccessToken();

    const params = new URLSearchParams({ id: this._info.broadcastId });
    await fetch(`${YT_API_BASE}/liveBroadcasts?${params}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch((err) => console.warn('[Broadcast] Delete error:', err));

    this._info = { broadcastId: '', streamId: '', rtmpUrl: '', streamKey: '', status: 'idle', createdAt: 0 };
    console.log('[Broadcast] Broadcast deleted');
  }

  // ── Stream health check ────────────────────────────────────────────────────────

  /**
   * Returns the current stream health from YouTube's perspective.
   * Must be "good" or "ok" before goLive() will work.
   */
  async getStreamHealth(): Promise<string> {
    if (!this._info.streamId) return 'unknown';

    const token = await youtubeAuthService.getAccessToken();
    const params = new URLSearchParams({
      part: 'status',
      id: this._info.streamId,
    });

    const res = await fetch(`${YT_API_BASE}/liveStreams?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return 'unknown';

    const body = (await res.json()) as {
      items?: Array<{ status?: { streamStatus?: string; healthStatus?: { status?: string } } }>;
    };

    const item = body.items?.[0];
    return item?.status?.healthStatus?.status ?? item?.status?.streamStatus ?? 'unknown';
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  private async _transition(broadcastStatus: 'live' | 'complete', token: string): Promise<void> {
    const params = new URLSearchParams({
      broadcastStatus,
      id: this._info.broadcastId,
      part: 'id,status',
    });

    const res = await fetch(`${YT_API_BASE}/liveBroadcasts/transition?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`liveBroadcasts.transition(${broadcastStatus}) failed (${res.status}): ${err.slice(0, 400)}`);
    }
  }

  private _setStatus(status: BroadcastLifecycleStatus): void {
    this._info = { ...this._info, status };
  }
}

export const youtubeBroadcastService = new YouTubeBroadcastService();
