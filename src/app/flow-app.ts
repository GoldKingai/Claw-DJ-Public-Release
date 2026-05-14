import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../ui/status-bar.js';
import '../ui/now-playing-bar.js';
import '../ui/ai-status-panel.js';
import '../ui/audio-spectrum-panel.js';
import '../ui/track-queue-panel.js';
import '../ui/session-stats-panel.js';
import '../ui/viewer-metrics-panel.js';
import '../ui/schedule-panel.js';
import '../ui/live-chat-panel.js';
import '../ui/brand-logo-panel.js';
import '../avatar/avatar-viewport.js';
import '../library/music-library.js';
import '../ui/settings-panel.js';
import { aiDjService, type QueuedTrack } from '../services/ai-dj-service.js';
import { nowPlayingSync, type RemoteNowPlaying } from '../services/nowplaying-sync.js';
import { playbackControlClient } from '../services/playback-control-client.js';
import { djEngineSync } from '../services/dj-engine-sync.js';
import { streamDeck } from '../services/stream-deck.js';
import type { TrackInfo } from '../library/library-service.js';
import type { NowPlayingTrack } from '../ui/now-playing-bar.js';

@customElement('flow-app')
export class FlowApp extends LitElement {
  @state() private _libraryOpen = false;
  @state() private _settingsOpen = false;
  /** True when ?stream is in the URL — hides interactive UI for OBS browser source */
  private readonly _streamMode = new URLSearchParams(window.location.search).has('stream');
  @state() private _currentBpm = 128;
  @state() private _isLive = false;
  @state() private _sessionStart = Date.now();
  @state() private _nowPlaying: NowPlayingTrack | null = null;
  @state() private _progress = 0;
  @state() private _queue: QueuedTrack[] = [];
  @state() private _isDjing = false;
  @state() private _djRunning = false;
  @state() private _flowMode: 'local' | 'live' = 'local';

  private _updateTimer: number | null = null;
  private _unsubscribe: (() => void) | null = null;

  static styles = css`
    /* ══════════════════════════════════════════════
       AI COMMAND CENTER LAYOUT
       ┌────────────────────────────────────────────┐
       │            STATUS BAR (40px)               │
       ├──────────┬──────────────────┬──────────────┤
       │          │                  │              │
       │  LEFT    │   3D VIEWPORT    │   RIGHT      │
       │  PANELS  │   (avatar)       │   PANELS     │
       │  280px   │                  │   280px      │
       │          │                  │              │
       ├──────────┴──────────────────┴──────────────┤
       │          NOW PLAYING (72px)                │
       └────────────────────────────────────────────┘
    ══════════════════════════════════════════════ */

    :host {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr var(--sidebar-width);
      grid-template-rows: var(--status-bar-h) 1fr var(--now-playing-h);
      grid-template-areas:
        "topbar   topbar   topbar"
        "left     viewport right"
        "nowplay  nowplay  nowplay";
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: var(--bg-void);
    }

    status-bar { grid-area: topbar; }

    .viewport-area {
      grid-area: viewport;
      position: relative;
      overflow: hidden;
      border-left: 1px solid var(--panel-border);
      border-right: 1px solid var(--panel-border);
    }

    .viewport-area avatar-viewport {
      display: block;
      width: 100%;
      height: 100%;
    }

    .sidebar-left {
      grid-area: left;
      display: flex;
      flex-direction: column;
      gap: var(--panel-gap);
      padding: var(--panel-gap);
      background: var(--bg-surface);
      overflow: hidden;
      min-height: 0;
    }

    .sidebar-right {
      grid-area: right;
      display: flex;
      flex-direction: column;
      gap: var(--panel-gap);
      padding: var(--panel-gap);
      background: var(--bg-surface);
      overflow: hidden;
      min-height: 0;
    }

    track-queue-panel {
      flex: 1;
      min-height: 0;
    }

    live-chat-panel {
      flex: 1;
      min-height: 0;
    }

    schedule-panel {
      flex-shrink: 0;
      height: 180px;
    }

    now-playing-bar { grid-area: nowplay; }

    music-library {
      position: fixed;
      top: var(--status-bar-h);
      right: 0;
      bottom: var(--now-playing-h);
      width: 420px;
      z-index: 50;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    music-library[open] {
      transform: translateX(0);
    }

    settings-panel {
      position: fixed;
      top: var(--status-bar-h);
      left: 0;
      bottom: var(--now-playing-h);
      width: 380px;
      z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    settings-panel[open] {
      transform: translateX(0);
    }

    .scanline-overlay {
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.015) 2px,
        rgba(0, 0, 0, 0.015) 4px
      );
      pointer-events: none;
      z-index: 9999;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();

    // Both modes: streamDeck is the audio engine.
    // Controller mode: the dashboard's browser plays audio through the OS
    // audio stack — OBS captures it via Audio Output Capture.
    // Stream mode (?stream): OBS captures via "Control audio via OBS".
    // Either way, audio comes from Web Audio API → OS audio → OBS.
    streamDeck.start();
    this._unsubscribe = nowPlayingSync.startReceiving((s) => this._applyServerState(s));

    if (!this._streamMode) {
      playbackControlClient.start();
      djEngineSync.start();
    }

    this._updateTimer = window.setInterval(() => this._pollDjState(), 50);

    // Hydrate mode + dj-running state from server on startup
    void this._hydrateDjState();
  }

  private async _hydrateDjState(): Promise<void> {
    try {
      const [modeRes, sessRes] = await Promise.all([
        fetch('/api/mode'),
        fetch('/api/session/state'),
      ]);
      const modeData = await modeRes.json();
      const sessData = await sessRes.json();
      if (modeData?.mode === 'local' || modeData?.mode === 'live') {
        this._flowMode = modeData.mode;
        // In local mode the browser-deck IS the audio source (no mpv→speakers
        // chain), so make it audible. In live mode the silenced default is
        // correct (mpv→PipeWire→OBS handles audio, browser is visual only).
        streamDeck.setAudible(modeData.mode === 'local');
      }
      // Session "active" status means DJ is running
      this._djRunning = sessData?.state?.status === 'active';
    } catch {
      // Non-critical
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) this._unsubscribe();
    if (this._updateTimer) clearInterval(this._updateTimer);
    streamDeck.stop();
    if (!this._streamMode) {
      playbackControlClient.stop();
      djEngineSync.stop();
    }
  }

  /** Sync UI state from the AI DJ service (called on state change events) */
  private _syncFromDj(): void {
    const track = aiDjService.currentTrack;
    if (track) {
      this._nowPlaying = {
        title: track.title,
        artist: track.artist,
        duration: track.duration,
      };
      this._currentBpm = track.bpm ?? 128;
    } else {
      this._nowPlaying = null;
    }

    this._queue = aiDjService.queue;
    this._isDjing = aiDjService.isPlaying;
  }

  /** Apply state received from the server (OBS Browser Source / viewer mode) */
  private _applyServerState(s: RemoteNowPlaying): void {
    if (s.track) {
      // Cast to include bpm/genre so session-stats-panel can read them
      this._nowPlaying  = {
        title: s.track.title,
        artist: s.track.artist,
        duration: s.track.duration,
        bpm: s.track.bpm,
        genre: s.track.genre,
      } as NowPlayingTrack;
      this._currentBpm  = s.track.bpm;
    } else {
      this._nowPlaying  = null;
      this._currentBpm  = 128;
    }
    this._queue    = s.queue;
    this._isDjing  = s.isPlaying;
    this._progress = s.progress;
  }

  /** Smooth progress bar from local streamDeck position (if audio is decoded) */
  private _pollDjState(): void {
    const dur = streamDeck.getDuration();
    if (dur > 0) {
      this._progress = (streamDeck.getPosition() / dur) * 100;
    }
  }

  render() {
    return html`
      <status-bar
        .isLive=${this._isLive}
        .sessionStart=${this._sessionStart}
        .libraryOpen=${this._libraryOpen}
        .settingsOpen=${this._settingsOpen}
        .streamMode=${this._streamMode}
        .djRunning=${this._djRunning}
        .flowMode=${this._flowMode}
        @toggle-library=${this._toggleLibrary}
        @toggle-settings=${this._toggleSettings}
        @toggle-live=${this._toggleLive}
        @dj-toggle=${this._onDjToggle}
        @mode-change=${this._onModeChange}
      ></status-bar>

      <div class="sidebar-left">
        ${this._flowMode === 'live' ? html`<ai-status-panel></ai-status-panel>` : ''}
        <audio-spectrum-panel .bpm=${this._currentBpm} .isPlaying=${this._isDjing}></audio-spectrum-panel>
        <track-queue-panel .queue=${this._queue}></track-queue-panel>
        <session-stats-panel .track=${this._nowPlaying} .isPlaying=${this._isDjing}></session-stats-panel>
      </div>

      <div class="viewport-area">
        <avatar-viewport .bpm=${this._currentBpm} .isDjing=${this._isDjing}></avatar-viewport>
      </div>

      <div class="sidebar-right">
        <brand-logo-panel></brand-logo-panel>
        ${this._flowMode === 'live' ? html`
          <viewer-metrics-panel></viewer-metrics-panel>
          <live-chat-panel></live-chat-panel>
          <schedule-panel></schedule-panel>
        ` : html`
          <div style="padding: 16px; color: rgba(140, 200, 230, 0.6); font-size: 11px; line-height: 1.5; border: 1px solid rgba(80, 220, 120, 0.2); border-radius: 6px; background: rgba(80, 220, 120, 0.04);">
            <div style="color: #6cdfa3; font-weight: 600; letter-spacing: 0.08em; margin-bottom: 8px;">▸ LOCAL DJ MODE</div>
            Streaming, AI banter, and chat are disabled. Pure offline music engine.
            <div style="margin-top: 12px; font-size: 10px; color: rgba(140, 200, 230, 0.4);">
              Switch to <strong style="color: rgba(140, 200, 230, 0.7);">LIVE STREAM</strong> in the top bar to enable Flow AI and YouTube broadcast.
            </div>
          </div>
        `}
      </div>

      <now-playing-bar
        .track=${this._nowPlaying}
        .bpm=${this._currentBpm}
        .progress=${this._progress}
      ></now-playing-bar>

      ${!this._streamMode ? html`
        <music-library
          ?open=${this._libraryOpen}
          @track-select=${this._onLibraryTrackSelect}
        ></music-library>
        <settings-panel
          ?open=${this._settingsOpen}
          @close=${this._toggleSettings}
        ></settings-panel>
      ` : ''}

      <div class="scanline-overlay"></div>
    `;
  }

  private _toggleLibrary() {
    this._libraryOpen = !this._libraryOpen;
  }

  private _toggleSettings() {
    this._settingsOpen = !this._settingsOpen;
  }

  private _toggleLive() {
    this._isLive = !this._isLive;
    if (this._isLive) {
      this._sessionStart = Date.now();
    }
  }

  private _onDjToggle(e: CustomEvent<{ running: boolean; mode: 'local' | 'live' }>) {
    this._djRunning = e.detail.running;
    this._flowMode = e.detail.mode;
    streamDeck.setAudible(e.detail.mode === 'local');
    if (this._djRunning) {
      this._sessionStart = Date.now();
    }
  }

  private _onModeChange(e: CustomEvent<{ mode: 'local' | 'live' }>) {
    this._flowMode = e.detail.mode;
    streamDeck.setAudible(e.detail.mode === 'local');
  }

  private async _onLibraryTrackSelect(e: CustomEvent<{ track: TrackInfo; deck: 'A' | 'B' }>) {
    const { track, deck } = e.detail;
    console.log(`[FlowApp] Track click: deck=${deck} id=${track.id} title="${track.title}"`);
    // Unlock AudioContext NOW while we're inside the user-gesture handler.
    // This must happen before the async fetch so ctx.resume() has a gesture.
    try {
      await streamDeck.unlock();
      console.log('[FlowApp] streamDeck.unlock() complete');
    } catch (err) {
      console.error('[FlowApp] streamDeck.unlock() failed:', err);
    }
    // Route through the server — dj-local-engine dispatches to streamDeck via SSE
    try {
      console.log('[FlowApp] POST /api/playback/commands play-track-now...');
      const res = await fetch('/api/playback/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'play-track-now', payload: { trackId: track.id } }),
      });
      const responseText = await res.text();
      console.log(`[FlowApp] play-track-now response: status=${res.status} body=${responseText.slice(0, 300)}`);
      if (!res.ok) {
        alert(`Track load failed (HTTP ${res.status}):\n${responseText}`);
      }
    } catch (err) {
      console.error('[FlowApp] play-track-now network error:', err);
      alert(`Network error loading track: ${err instanceof Error ? err.message : err}`);
    }
  }
}
