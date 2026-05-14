/**
 * discord-service.ts
 *
 * Native Discord bot for Flow. Replaces LLM Gateway's Discord channel integration.
 * Routes messages through getWatchdogDiscordHandler() — same DJ context + TTS as YouTube chat,
 * with bridge fallback when LLM Gateway is rate-limited. No YouTube chat cross-posting.
 *
 * Config via env vars:
 *   DISCORD_BOT_TOKEN      — bot token (required)
 *   DISCORD_CHANNEL_IDS    — comma-separated channel IDs to listen in
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, BaseGuildTextChannel } from 'discord.js';
import { getWatchdogDiscordHandler } from './watchdog.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_CHANNELS = (
  process.env.DISCORD_CHANNEL_IDS ?? '1486326693843963974,1485957488397385779'
).split(',').map(s => s.trim()).filter(Boolean);

const DISCORD_MAX_LEN = 1900; // leave headroom under 2000

let client: Client | null = null;

/** Split a long string into chunks that fit within Discord's message limit. */
function chunkMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_MAX_LEN) {
    // Try to split on a newline near the limit
    const slice = remaining.slice(0, DISCORD_MAX_LEN);
    const lastNewline = slice.lastIndexOf('\n');
    const cutAt = lastNewline > DISCORD_MAX_LEN / 2 ? lastNewline : DISCORD_MAX_LEN;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!ALLOWED_CHANNELS.includes(message.channelId)) return;
  const text = message.content.trim();
  if (!text) return;

  const channel = message.channel as BaseGuildTextChannel;

  // Keep typing indicator alive while we wait (refreshes every 9s)
  let typingActive = true;
  const typingInterval = setInterval(() => {
    if (typingActive) channel.sendTyping().catch(() => {});
  }, 9_000);
  channel.sendTyping().catch(() => {});

  try {
    const handler = getWatchdogDiscordHandler();
    const response = await handler(message.author.username, text);
    typingActive = false;
    clearInterval(typingInterval);

    if (!response) return;

    const chunks = chunkMessage(response);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else {
        await channel.send(chunks[i]);
      }
    }
  } catch (err) {
    typingActive = false;
    clearInterval(typingInterval);
    console.error('[Discord] Error handling message:', (err as Error).message);
  }
}

export function startDiscordService(): void {
  if (!TOKEN) {
    console.log('[Discord] DISCORD_BOT_TOKEN not set — skipping');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag} — watching ${ALLOWED_CHANNELS.length} channel(s)`);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch(err =>
      console.error('[Discord] Unhandled error:', (err as Error).message)
    );
  });

  client.on(Events.Error, (err) => {
    console.error('[Discord] Client error:', err.message);
  });

  client.login(TOKEN).catch(err => {
    console.error('[Discord] Login failed:', (err as Error).message);
  });
}

export function stopDiscordService(): void {
  client?.destroy();
  client = null;
  console.log('[Discord] Stopped');
}
