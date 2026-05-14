/**
 * Mode Manager
 *
 * Two top-level operating modes:
 *
 *   - 'local'  → Party/DJ mode. Music plays, watchdog auto-mixes,
 *                crossfades happen — but NO LLM calls, NO TTS,
 *                NO Discord, NO YouTube broadcast/chat. Pure music engine.
 *
 *   - 'live'   → Full stream mode. Everything above PLUS Flow AI banter,
 *                TTS, Discord, YouTube broadcast + chat polling.
 *
 * Mode is persisted to storage/state/mode.json so it survives restarts.
 * All other services (watchdog, flow-agent, youtube-chat, discord) consult
 * isLive() before performing AI/social/streaming work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export type FlowMode = 'local' | 'live';

const STATE_DIR = path.resolve(process.cwd(), 'storage/state');
const STATE_FILE = path.join(STATE_DIR, 'mode.json');
const DEFAULT_MODE: FlowMode = 'local';

interface ModeState {
  mode: FlowMode;
  changedAt: number;
}

class ModeManager extends EventEmitter {
  private _state: ModeState;

  constructor() {
    super();
    this._state = this._load();
  }

  private _load(): ModeState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (raw.mode === 'local' || raw.mode === 'live') {
          return { mode: raw.mode, changedAt: raw.changedAt ?? Date.now() };
        }
      }
    } catch (e) {
      console.warn('[mode] Failed to load state, defaulting to local:', (e as Error).message);
    }
    return { mode: DEFAULT_MODE, changedAt: Date.now() };
  }

  private _persist(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2));
    } catch (e) {
      console.warn('[mode] Failed to persist state:', (e as Error).message);
    }
  }

  /** Current mode ('local' or 'live'). */
  get mode(): FlowMode {
    return this._state.mode;
  }

  /** True if AI/TTS/Discord/YouTube features should be active. */
  isLive(): boolean {
    return this._state.mode === 'live';
  }

  /** True if running as a pure local DJ (no AI/social/streaming). */
  isLocal(): boolean {
    return this._state.mode === 'local';
  }

  /** Switch mode. Emits 'change' event with new mode. */
  setMode(next: FlowMode): void {
    if (next !== 'local' && next !== 'live') {
      throw new Error(`Invalid mode: ${next}`);
    }
    if (this._state.mode === next) return;
    const prev = this._state.mode;
    this._state = { mode: next, changedAt: Date.now() };
    this._persist();
    console.log(`[mode] Switched ${prev} → ${next}`);
    this.emit('change', next, prev);
  }

  getState(): ModeState {
    return { ...this._state };
  }
}

export const modeManager = new ModeManager();
