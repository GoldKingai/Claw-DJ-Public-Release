/**
 * ayla-agent.ts
 *
 * Sends chat messages to the LLM Gateway and returns Ayla's response.
 * LLM Gateway handles all AI logic: SOUL.md personality, SKILL.md DJ context,
 * conversation memory, TTS synthesis, and Discord.
 *
 * Backed by GPT-5.4 via LLM Gateway → ChatGPT OAuth.
 */

const OPENCLAW_URL   = process.env.OPENCLAW_URL   ?? 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN ?? '7da9c47934fac38260cb0624796f413e97a2a0f49e526432';
const REQUEST_TIMEOUT_MS = 30_000;

export async function askAyla(user: string, text: string): Promise<string> {
  try {
    const res = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENCLAW_TOKEN}` },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: user ? `${user}: ${text}` : text }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[AylaAgent] LLM Gateway returned ${res.status}`);
      return '';
    }

    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return json.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    console.error('[AylaAgent] Could not reach LLM Gateway:', (err as Error).message);
    return '';
  }
}
