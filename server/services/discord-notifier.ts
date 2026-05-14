/**
 * Discord Notifier — lightweight webhook-based alerting for claw-dj.
 * Uses native fetch (Node 18+), no new npm dependencies.
 * Configure with DISCORD_WEBHOOK_URL environment variable.
 * Silently no-ops when the webhook URL is not set.
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? '';

export type NotifyLevel = 'info' | 'warn' | 'error' | 'success';

const LEVEL_EMOJI: Record<NotifyLevel, string> = {
  info:    'ℹ️',
  warn:    '⚠️',
  error:   '🔴',
  success: '✅',
};

const LEVEL_COLOR: Record<NotifyLevel, number> = {
  info:    0x5865F2, // Discord blurple
  warn:    0xFEE75C, // Yellow
  error:   0xED4245, // Red
  success: 0x57F287, // Green
};

export interface NotifyOptions {
  level?: NotifyLevel;
  title?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

/**
 * Send a notification to Discord via webhook.
 * Always resolves — never throws (non-fatal for callers).
 */
export async function notify(message: string, opts: NotifyOptions = {}): Promise<void> {
  if (!WEBHOOK_URL) return;

  const level = opts.level ?? 'info';
  const emoji = LEVEL_EMOJI[level];

  const body: Record<string, unknown> = {
    embeds: [{
      title:       opts.title ? `${emoji} ${opts.title}` : undefined,
      description: opts.title ? message : `${emoji} ${message}`,
      color:       LEVEL_COLOR[level],
      timestamp:   new Date().toISOString(),
      fields:      opts.fields ?? [],
    }],
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn(`[DiscordNotifier] Webhook returned ${res.status}`);
    }
  } catch (err) {
    console.warn('[DiscordNotifier] Failed to send:', err instanceof Error ? err.message : String(err));
  }
}

// ── Convenience helpers ───────────────────────────────────────────────────────

export const notifyInfo    = (msg: string, opts?: Omit<NotifyOptions, 'level'>) => notify(msg, { ...opts, level: 'info' });
export const notifyWarn    = (msg: string, opts?: Omit<NotifyOptions, 'level'>) => notify(msg, { ...opts, level: 'warn' });
export const notifyError   = (msg: string, opts?: Omit<NotifyOptions, 'level'>) => notify(msg, { ...opts, level: 'error' });
export const notifySuccess = (msg: string, opts?: Omit<NotifyOptions, 'level'>) => notify(msg, { ...opts, level: 'success' });
