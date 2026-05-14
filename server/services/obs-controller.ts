/**
 * OBS WebSocket Controller
 *
 * Controls OBS Studio remotely via obs-websocket-js (OBS WebSocket v5 protocol).
 *
 * OBS Setup (one-time):
 *   Tools → WebSocket Server Settings
 *   ✓ Enable WebSocket server
 *   Port: 4455 (default)
 *   ✓ Enable authentication  →  set a password
 *
 * Config via env vars (optional — can also be set via Settings):
 *   OBS_WS_URL       default: ws://localhost:4455
 *   OBS_WS_PASSWORD  default: (empty — set if authentication is enabled)
 *
 * Key methods:
 *   connect()         — connect to OBS WebSocket
 *   disconnect()      — disconnect
 *   startStreaming()  — start streaming in OBS
 *   stopStreaming()   — stop streaming in OBS
 *   getStatus()       — returns {streaming, recording, connected}
 */

import OBSWebSocket from 'obs-websocket-js';
import { opsMemory } from './ops-memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirnameObs = path.dirname(fileURLToPath(import.meta.url));
const OBS_CONFIG_FILE = path.join(__dirnameObs, '../data/obs-config.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OBSStatus {
  connected: boolean;
  streaming: boolean;
  recording: boolean;
  streamTimecode: string;  // HH:MM:SS.mmm — empty if not streaming
}

// ── Service ───────────────────────────────────────────────────────────────────

class OBSController {
  private obs = new OBSWebSocket();
  private _connected = false;
  private _url = 'ws://localhost:4455';
  private _password = '';
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 10;

  // ── Init ─────────────────────────────────────────────────────────────────────

  initFromEnv(): void {
    // Restore persisted config from previous session (env vars take precedence)
    this._loadPersistedConfig();

    const wsUrl = process.env.OBS_WS_URL || '';
    const wsPassword = process.env.OBS_WS_PASSWORD || '';

    // Backward-compatible support for legacy split host/port/password env vars.
    const host = process.env.OBS_HOST || '';
    const port = process.env.OBS_PORT || '';
    const legacyPassword = process.env.OBS_PASSWORD || '';

    const url = wsUrl || (host ? `ws://${host}:${port || '4455'}` : '');
    const password = wsPassword || legacyPassword;

    // Env vars override persisted config (already loaded by _loadPersistedConfig)
    if (url) this._url = url;
    if (password) this._password = password;

    // Connect if we have any config (from env or persisted disk)
    const hasConfig = this._password || this._url !== 'ws://localhost:4455';
    if (hasConfig || url || password) {
      const source = (url || password) ? (wsUrl ? 'OBS_WS_* env' : 'legacy OBS_HOST/PORT env') : 'saved config';
      console.log(`[OBS] Auto-configuring from ${source}`);
      this.connect().catch((err) => {
        console.warn('[OBS] Initial connect failed:', (err as Error).message);
      });
    } else {
      console.log('[OBS] No OBS config found — waiting for POST /api/obs/config');
    }
  }

  configure(url: string, password: string): void {
    this._url      = url || 'ws://localhost:4455';
    this._password = password;
    this._reconnectAttempts = 0;
    if (this._connected) {
      this.disconnect().then(() => this.connect()).catch(console.error);
    } else {
      this.connect().catch(console.error);
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    try {
      await this.obs.connect(this._url, this._password || undefined);
      this._connected = true;
      this._reconnectAttempts = 0;
      console.log(`[OBS] Connected to ${this._url}`);
      opsMemory.addIncident('obs_connected', this._url);

      this.obs.on('ConnectionClosed', () => {
        this._connected = false;
        console.warn('[OBS] Connection closed — scheduling reconnect');
        opsMemory.addIncident('obs_disconnected', 'ConnectionClosed event');
        this._scheduleReconnect();
      });

      this.obs.on('ConnectionError', (err) => {
        this._connected = false;
        console.warn('[OBS] Connection error:', err.message);
        opsMemory.addIncident('obs_error', err.message);
      });
    } catch (err) {
      this._connected = false;
      throw new Error(`OBS WebSocket connect failed: ${(err as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.obs.removeAllListeners();
    if (this._connected) {
      await this.obs.disconnect();
      this._connected = false;
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.warn('[OBS] Max reconnect attempts reached — giving up');
      return;
    }
    const delay = Math.min(5_000 * (this._reconnectAttempts + 1), 60_000);
    this._reconnectAttempts++;
    console.log(`[OBS] Reconnect attempt ${this._reconnectAttempts} in ${delay / 1000}s`);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.warn('[OBS] Reconnect failed:', (err as Error).message);
      });
    }, delay);
  }

  // ── Streaming control ─────────────────────────────────────────────────────────

  async startStreaming(): Promise<void> {
    this._requireConnection();
    const status = await this._getStreamStatus();

    if (status.outputActive) {
      console.log('[OBS] Already streaming — no-op');
      return;
    }

    await this.obs.call('StartStream');
    console.log('[OBS] Streaming started');
  }

  async stopStreaming(): Promise<void> {
    this._requireConnection();
    const status = await this._getStreamStatus();

    if (!status.outputActive) {
      console.log('[OBS] Not streaming — no-op');
      return;
    }

    await this.obs.call('StopStream');
    console.log('[OBS] Streaming stopped');
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  async getStatus(): Promise<OBSStatus> {
    if (!this._connected) {
      return { connected: false, streaming: false, recording: false, streamTimecode: '' };
    }

    try {
      const [streamStatus, recordStatus] = await Promise.all([
        this._getStreamStatus(),
        this.obs.call('GetRecordStatus'),
      ]);

      return {
        connected: true,
        streaming: streamStatus.outputActive,
        recording: recordStatus.outputActive,
        streamTimecode: streamStatus.outputTimecode ?? '',
      };
    } catch (err) {
      console.warn('[OBS] getStatus error:', err);
      return { connected: false, streaming: false, recording: false, streamTimecode: '' };
    }
  }

  get isConnected(): boolean {
    return this._connected;
  }

  // ── Scene management ──────────────────────────────────────────────────────────

  async setScene(sceneName: string): Promise<void> {
    this._requireConnection();
    await this.obs.call('SetCurrentProgramScene', { sceneName });
    console.log(`[OBS] Switched to scene: ${sceneName}`);
  }

  async listScenes(): Promise<string[]> {
    this._requireConnection();
    const res = await this.obs.call('GetSceneList');
    return res.scenes.map((s) => s.sceneName as string);
  }

  // ── Input management ──────────────────────────────────────────────────────────

  async setInputMuted(inputName: string, muted: boolean): Promise<void> {
    this._requireConnection();
    await this.obs.call('SetInputMute', { inputName, inputMuted: muted });
    console.log(`[OBS] Input "${inputName}" muted=${muted}`);
  }

  async listInputs(): Promise<Array<{ inputName: string; inputKind: string }>> {
    this._requireConnection();
    const res = await this.obs.call('GetInputList');
    return res.inputs.map((i) => ({
      inputName: i.inputName as string,
      inputKind: i.inputKind as string,
    }));
  }

  /**
   * Refresh a browser source by name (equivalent to clicking "Refresh" in OBS).
   * inputName must match exactly what's shown in OBS sources panel.
   */
  async refreshBrowserSource(inputName: string): Promise<void> {
    this._requireConnection();
    await this.obs.call('PressInputPropertiesButton', {
      inputName,
      propertyName: 'refreshnocache',
    });
    console.log(`[OBS] Refreshed browser source: ${inputName}`);
  }

  /**
   * Find all browser_source inputs and refresh them all.
   * Returns the list of input names that were refreshed.
   */
  async refreshAllBrowserSources(): Promise<string[]> {
    const inputs = await this.listInputs();
    const browserInputs = inputs.filter((i) => i.inputKind === 'browser_source');
    for (const input of browserInputs) {
      await this.refreshBrowserSource(input.inputName);
    }
    return browserInputs.map((i) => i.inputName);
  }

  /**
   * Create a browser source in OBS and add it to a scene.
   * If an input with that name already exists, skips creation.
   * Returns true if created, false if already existed.
   */
  async ensureBrowserSource(
    inputName: string,
    url: string,
    sceneName: string,
    width = 1920,
    height = 1080,
  ): Promise<boolean> {
    this._requireConnection();
    const existing = await this.listInputs();
    if (existing.some((i) => i.inputName === inputName)) {
      console.log(`[OBS] Browser source "${inputName}" already exists — skipping create`);
      return false;
    }
    await this.obs.call('CreateInput', {
      sceneName,
      inputName,
      inputKind: 'browser_source',
      inputSettings: {
        url,
        width,
        height,
        css: '',
        shutdown: false,
        restart_when_active: false,
      },
      sceneItemEnabled: true,
    });
    console.log(`[OBS] Created browser source "${inputName}" → ${url}`);
    return true;
  }

  async removeInput(inputName: string): Promise<void> {
    this._requireConnection();
    await this.obs.call('RemoveInput', { inputName });
    console.log(`[OBS] Removed input: ${inputName}`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  private _requireConnection(): void {
    if (!this._connected) {
      throw new Error('OBS is not connected — call connect() or configure() first');
    }
  }

  private async _getStreamStatus(): Promise<{ outputActive: boolean; outputTimecode?: string }> {
    return this.obs.call('GetStreamStatus');
  }

  /** Persist OBS URL + password to disk so they survive restarts.
   *  File mode 0600 + dir mode 0700 — OBS WebSocket password grants full
   *  streaming control, so other users on the host must not read it.
   *  (chmod is a no-op on win32, harmless.) */
  saveConfig(url: string, password: string): void {
    try {
      const dir = path.dirname(OBS_CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        OBS_CONFIG_FILE,
        JSON.stringify({ url, password }, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
    } catch (err) {
      console.warn('[OBS] Could not persist config:', err);
    }
  }

  /** Load persisted OBS config from disk. Called once in initFromEnv() before env-var override. */
  private _loadPersistedConfig(): void {
    try {
      if (fs.existsSync(OBS_CONFIG_FILE)) {
        const raw = fs.readFileSync(OBS_CONFIG_FILE, 'utf-8');
        const cfg = JSON.parse(raw) as { url?: string; password?: string };
        if (cfg.url)      this._url      = cfg.url;
        if (cfg.password) this._password = cfg.password;
        console.log('[OBS] Restored config from disk — will auto-connect');
      }
    } catch {
      // Config file missing or corrupt — silent
    }
  }
}

export const obsController = new OBSController();
