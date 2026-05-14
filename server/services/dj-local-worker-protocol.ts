/**
 * Typed protocol for the dj-local-worker TCP interface.
 * Worker listens on 127.0.0.1:3011, newline-delimited JSON.
 */

export const PROTOCOL_VERSION = 2;

// ── Inbound commands ──────────────────────────────────────────────────────────

export type WorkerCommandType =
  | "ping"
  | "play"
  | "pause"
  | "resume"
  | "stop"
  | "seek"
  | "set-volume"
  | "status"
  | "preload"
  | "crossfade";

export interface WorkerBaseRequest {
  requestId: string;
  type: WorkerCommandType;
}

export interface WorkerPingRequest extends WorkerBaseRequest { type: "ping"; }
export interface WorkerPauseRequest extends WorkerBaseRequest { type: "pause"; }
export interface WorkerResumeRequest extends WorkerBaseRequest { type: "resume"; }
export interface WorkerStopRequest extends WorkerBaseRequest { type: "stop"; }
export interface WorkerStatusRequest extends WorkerBaseRequest { type: "status"; }

export interface WorkerPlayRequest extends WorkerBaseRequest {
  type: "play";
  uri: string;
  playbackToken: string;
  trackId?: string;
  title?: string;
  artist?: string;
  duration?: number;
}

export interface WorkerSeekRequest extends WorkerBaseRequest {
  type: "seek";
  positionSeconds: number;
}

export interface WorkerSetVolumeRequest extends WorkerBaseRequest {
  type: "set-volume";
  volume: number; // 0.0 - 1.0
}

export type WorkerRequest =
  | WorkerPingRequest
  | WorkerPlayRequest
  | WorkerPauseRequest
  | WorkerResumeRequest
  | WorkerStopRequest
  | WorkerSeekRequest
  | WorkerSetVolumeRequest
  | WorkerStatusRequest
  | WorkerPreloadRequest
  | WorkerCrossfadeRequest;

// ── Worker state ──────────────────────────────────────────────────────────────

export type WorkerMode = "idle" | "playing" | "paused" | "error";

export interface WorkerCurrentTrack {
  trackId?: string;
  uri: string;
  title?: string;
  artist?: string;
  duration?: number;
  loadedAt: number;
}

export interface WorkerState {
  protocolVersion: number;
  workerId: string;
  mode: WorkerMode;
  currentTrack: WorkerCurrentTrack | null;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  muted: boolean;
  buffering: boolean;
  eosCount: number;
  currentPlaybackToken: string | null;
  lastError: string;
  updatedAt: number;
  lastCommandAt: number;
}

// ── Outbound responses ────────────────────────────────────────────────────────

export type WorkerErrorCode =
  | "INVALID_STATE"
  | "INVALID_PARAMS"
  | "PLAYBACK_ERROR"
  | "SEEK_ERROR"
  | "UNKNOWN_ACTION";

export interface WorkerSuccessResponse {
  ok: true;
  requestId: string;
  type: WorkerCommandType;
  state: WorkerState;
}

export interface WorkerErrorResponse {
  ok: false;
  requestId: string;
  type: WorkerCommandType;
  error: {
    code: WorkerErrorCode;
    message: string;
  };
  state: WorkerState;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

// ── Dual-deck extension types ─────────────────────────────────────────────────

export interface DeckState {
  deckId: 'a' | 'b';
  mode: WorkerMode;
  currentTrack: WorkerCurrentTrack | null;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  eosCount: number;
  currentPlaybackToken: string | null;
  lastError: string;
}

// WorkerState is extended in v2 with dual-deck fields (backward-compatible)
export interface WorkerStateV2 extends WorkerState {
  activeDeck: 'a' | 'b';
  decks: { a: DeckState; b: DeckState };
}

export interface WorkerPreloadRequest extends WorkerBaseRequest {
  type: 'preload';
  uri: string;
  playbackToken: string;
  trackId?: string;
  title?: string;
  artist?: string;
  duration?: number;
}

export interface WorkerCrossfadeRequest extends WorkerBaseRequest {
  type: 'crossfade';
  durationSeconds?: number;
}
