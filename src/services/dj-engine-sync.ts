/**
 * dj-engine-sync (LEGACY SHIM)
 *
 * The browser-as-controller sync model was retired — the server's local
 * engine now owns playback state directly. This client previously POSTed
 * to /api/dj-engine/sync and /ack every 5s, which now returns 410 Gone.
 *
 * The 410s were noise in the console without any functional effect.
 * Now the client just heartbeats the controller endpoint (still live) and
 * skips the deprecated sync/ack calls entirely.
 *
 * Kept as a no-op start()/stop() so callers (claw-app.ts) don't need
 * conditional wiring.
 */

class DjEngineSync {
  private heartbeatTimer: number | null = null;

  start(): void {
    if (this.heartbeatTimer) return;
    // Lightweight heartbeat so the server knows a controller is alive.
    // (Sync + ack endpoints are deprecated — server owns state via SSE.)
    this.heartbeatTimer = window.setInterval(() => {
      void fetch('/api/dj-engine/controller/heartbeat', { method: 'POST' }).catch(() => {});
    }, 30_000);
    void fetch('/api/dj-engine/controller/heartbeat', { method: 'POST' }).catch(() => {});
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    void fetch('/api/dj-engine/controller/offline', { method: 'POST' }).catch(() => {});
  }

  async ackCommand(): Promise<void> {
    // No-op — server doesn't expect acks anymore.
  }
}

export const djEngineSync = new DjEngineSync();
