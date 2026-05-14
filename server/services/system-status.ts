/**
 * Unified system status helper.
 *
 * Merges OBS, scheduler, stream detection, YouTube auth, metrics, and chat
 * service state into a single health snapshot so callers don't need to infer
 * system readiness from multiple endpoints.
 */

import { obsController } from './obs-controller.js';
import { broadcastScheduler } from './broadcast-scheduler.js';
import { youtubeStreamDetector } from './youtube-stream-detector.js';
import { youtubeAuthService } from './youtube-auth.js';
import { youtubeMetricsService } from './youtube-metrics.js';
import { youtubeChatService } from './youtube-chat.js';
import { chatOrchestrator } from './chat-orchestrator.js';
import { opsMemory } from './ops-memory.js';
import { getNowPlayingState } from '../routes/nowplaying.js';
import { djEngine } from './dj-engine.js';
import { djLocalEngine } from './dj-local-engine.js';

export interface SystemStatusSnapshot {
  ready: boolean;
  mode: 'idle' | 'preparing' | 'warming' | 'live' | 'degraded';
  issues: string[];
  obs: {
    connected: boolean;
  };
  youtube: {
    authConfigured: boolean;
    authorized: boolean;
    detectorConfigured: boolean;
    isLive: boolean;
    quotaBlocked: boolean;
    quotaDebug: {
      blockedBy: string[];           // which subsystems have active quota errors
      lastQuotaErrorAt: number;      // most recent quota error timestamp (ms epoch)
      lastQuotaErrorAge: string;     // human-readable age ("3h ago")
      backoffUntil: number;          // estimated backoff end (lastError + 24h)
      recentIncidents: Array<{ type: string; detail: string; at: number }>;
    };
  };
  chat: {
    configured: boolean;
    poolSize: number;
    moderatedFlags: number;
  };
  metrics: {
    configured: boolean;
    viewers: number;
  };
  scheduler: {
    status: string;
    lastError: string;
  };
  playback: {
    isPlaying: boolean;
    hasTrack: boolean;
    queueLength: number;
  };
  recovery: {
    canReconnectObs: boolean;
    canRestartClawDj: boolean;
    canRestartLuxTts: boolean;
  };
  controller: {
    online: boolean;
    lastSeenAt: number;
    lastCommandAckAt: number;
    role: string;
  };
  localEngine: {
    backend: string;
    mode: string;
    queueLength: number;
    queueRevision: number;
    crossfadeSeconds: number;
    positionSeconds: number;
    durationSeconds: number;
    currentTrackId: string | null;
    currentTrackTitle: string | null;
    currentTrackArtist: string | null;
    workerConnected: boolean;
    workerMode: string;
    lastError: string;
  };
}

export function getSystemStatus(): SystemStatusSnapshot {
  const scheduler = broadcastScheduler.state;
  const detector = youtubeStreamDetector.status;
  const playback = getNowPlayingState();
  const controller = djEngine.snapshot();
  const localEngine = djLocalEngine.snapshot();
  const detectorQuotaAt  = youtubeStreamDetector.lastQuotaErrorAt;
  const metricsQuotaAt   = youtubeMetricsService.lastQuotaErrorAt;
  const chatQuotaAt      = youtubeChatService.lastQuotaErrorAt;
  const quotaBlocked     = detectorQuotaAt > 0 || metricsQuotaAt > 0 || chatQuotaAt > 0;

  const blockedBy: string[] = [];
  if (detectorQuotaAt > 0) blockedBy.push('detector');
  if (metricsQuotaAt > 0) blockedBy.push('metrics');
  if (chatQuotaAt > 0) blockedBy.push('chat');

  const lastQuotaErrorAt = Math.max(detectorQuotaAt, metricsQuotaAt, chatQuotaAt);
  const backoffUntil = lastQuotaErrorAt > 0 ? lastQuotaErrorAt + 24 * 60 * 60_000 : 0;

  function _ageStr(ms: number): string {
    if (ms <= 0) return 'never';
    const secs = Math.round((Date.now() - ms) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    return Math.round(secs / 3600) + 'h ago';
  }

  const recentQuotaIncidents = opsMemory.snapshot().incidents
    .filter(i => i.type === 'youtube_quota')
    .slice(-10);

  const issues: string[] = [];

  if (!obsController.isConnected) issues.push('OBS disconnected');
  if (!youtubeAuthService.isConfigured) issues.push('YouTube OAuth credentials missing');
  if (!youtubeAuthService.isAuthorized) issues.push('YouTube OAuth not authorized');
  if (!youtubeStreamDetector.isConfigured) issues.push('YouTube stream detector not configured');
  if (quotaBlocked) issues.push('YouTube API quota currently blocked');
  if (scheduler.lastError) issues.push(`Scheduler: ${scheduler.lastError}`);
  if (!localEngine.workerConnected) issues.push('Local audio worker disconnected');

  let mode: SystemStatusSnapshot['mode'] = 'idle';
  if (scheduler.status === 'creating') mode = 'preparing';
  else if (scheduler.status === 'warming') mode = 'warming';
  else if (scheduler.status === 'live' || detector.isLive) mode = 'live';
  else if (issues.length > 0) mode = 'degraded';

  const ready =
    obsController.isConnected &&
    youtubeAuthService.isAuthorized &&
    youtubeStreamDetector.isConfigured &&
    localEngine.workerConnected;

  return {
    ready,
    mode,
    issues,
    obs: {
      connected: obsController.isConnected,
    },
    youtube: {
      authConfigured: youtubeAuthService.isConfigured,
      authorized: youtubeAuthService.isAuthorized,
      detectorConfigured: youtubeStreamDetector.isConfigured,
      isLive: detector.isLive,
      quotaBlocked,
      quotaDebug: {
        blockedBy,
        lastQuotaErrorAt,
        lastQuotaErrorAge: _ageStr(lastQuotaErrorAt),
        backoffUntil,
        recentIncidents: recentQuotaIncidents,
      },
    },
    chat: {
      configured: youtubeChatService.isConfigured,
      poolSize: youtubeChatService.poolSize,
      moderatedFlags: chatOrchestrator.getStatus().flagCount,
    },
    metrics: {
      configured: youtubeMetricsService.isConfigured,
      viewers: youtubeMetricsService.snapshot.viewers,
    },
    scheduler: {
      status: scheduler.status,
      lastError: scheduler.lastError,
    },
    playback: {
      isPlaying: playback.isPlaying,
      hasTrack: !!playback.track,
      queueLength: playback.queue.length,
    },
    recovery: {
      canReconnectObs: true,
      canRestartClawDj: true,
      canRestartLuxTts: true,
    },
    controller: {
      online: controller.controllerOnline,
      lastSeenAt: controller.lastControllerSeenAt,
      lastCommandAckAt: controller.lastCommandAckAt,
      role: 'browser-mirror',
    },
    localEngine: {
      backend: localEngine.backend,
      mode: localEngine.mode,
      queueLength: localEngine.queue.length,
      queueRevision: localEngine.queueRevision,
      crossfadeSeconds: localEngine.crossfadeSeconds,
      positionSeconds: Number(localEngine.workerState?.positionSeconds ?? 0),
      durationSeconds: Number(localEngine.workerState?.durationSeconds ?? 0),
      currentTrackId: localEngine.currentTrackId,
      currentTrackTitle: localEngine.currentTrackTitle,
      currentTrackArtist: localEngine.currentTrackArtist,
      workerConnected: localEngine.workerConnected,
      workerMode: localEngine.workerState?.mode ?? 'unknown',
      lastError: localEngine.lastError,
    },
  };
}
