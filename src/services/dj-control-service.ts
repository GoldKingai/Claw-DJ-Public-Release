/**
 * DJ Control Service (client-side)
 *
 * Thin wrapper around the server's session start-auto / stop-auto / mode endpoints.
 * Provides a stable surface for UI components (Start button, mode toggle) to
 * trigger the autonomous DJ chain without each component knowing the API shape.
 */

export type FlowMode = 'local' | 'live';

export interface DjStartResult {
  ok: boolean;
  mode: FlowMode;
  currentTrack: string | null;
  error?: string;
}

export interface ModeState {
  mode: FlowMode;
  changedAt: number;
}

class DjControlService {
  /**
   * Start the full autonomous DJ chain.
   * - Optionally switches mode first
   * - Generates a night plan
   * - Starts the first genre session
   * - Kicks the first track (watchdog takes over after that)
   */
  async startAuto(opts: { mode?: FlowMode; durationMins?: number } = {}): Promise<DjStartResult> {
    try {
      const res = await fetch('/api/session/start-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: opts.mode,
          streamDurationMins: opts.durationMins,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          mode: data.mode ?? 'local',
          currentTrack: null,
          error: data.error ?? `HTTP ${res.status}`,
        };
      }
      return {
        ok: true,
        mode: data.mode,
        currentTrack: data.currentTrack ?? null,
      };
    } catch (e) {
      return {
        ok: false,
        mode: 'local',
        currentTrack: null,
        error: e instanceof Error ? e.message : 'Network error',
      };
    }
  }

  /** Stop everything — ends session, clears queue, stops playback. */
  async stopAuto(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('/api/session/stop-auto', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  }

  /** Get current mode ('local' or 'live'). */
  async getMode(): Promise<ModeState> {
    try {
      const res = await fetch('/api/mode');
      const data = await res.json();
      return { mode: data.mode ?? 'local', changedAt: data.changedAt ?? 0 };
    } catch {
      return { mode: 'local', changedAt: 0 };
    }
  }

  /** Switch mode without starting a session. */
  async setMode(mode: FlowMode): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  }
}

export const djControl = new DjControlService();
