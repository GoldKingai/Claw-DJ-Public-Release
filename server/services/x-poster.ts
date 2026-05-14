/**
 * x-poster.ts
 *
 * Posts tweets to X (Twitter) as @FlowDJ.
 * Uses OAuth 1.0a — tweet-level write access.
 * Rate limit: free tier allows ~17 posts/day safely within 1500/month.
 */

import { TwitterApi } from 'twitter-api-v2';

// Lazy-init: don't instantiate at module load time. Twitter API throws
// 'Invalid consumer tokens' if env vars are missing, which would crash the
// whole server. In local mode (no X credentials), the rest of the system
// must still boot. Client is created on first use, only when keys are set.
type RwClient = TwitterApi['readWrite'];

let _client: TwitterApi | null = null;
let _rwClient: RwClient | null = null;

function _getClient(): RwClient | null {
  if (_rwClient) return _rwClient;
  if (!process.env.X_CONSUMER_KEY || !process.env.X_CONSUMER_SECRET
      || !process.env.X_ACCESS_TOKEN || !process.env.X_ACCESS_TOKEN_SECRET) {
    return null;
  }
  _client = new TwitterApi({
    appKey:        process.env.X_CONSUMER_KEY,
    appSecret:     process.env.X_CONSUMER_SECRET,
    accessToken:   process.env.X_ACCESS_TOKEN,
    accessSecret:  process.env.X_ACCESS_TOKEN_SECRET,
  });
  _rwClient = _client.readWrite;
  return _rwClient;
}

// Minimum 5 minutes between posts (anti-spam guard)
const MIN_POST_INTERVAL_MS = 5 * 60 * 1000;
let _lastPostedAt = 0;

export interface XPostResult {
  ok: boolean;
  tweetId?: string;
  error?: string;
}

/**
 * Post a tweet as @FlowDJ.
 * Returns the tweet ID on success.
 */
export async function postTweet(text: string, force = false): Promise<XPostResult> {
  const rw = _getClient();
  if (!rw) {
    return { ok: false, error: 'X API keys not configured' };
  }

  const now = Date.now();
  if (!force && now - _lastPostedAt < MIN_POST_INTERVAL_MS) {
    const waitSecs = Math.ceil((MIN_POST_INTERVAL_MS - (now - _lastPostedAt)) / 1000);
    return { ok: false, error: `Rate limited — wait ${waitSecs}s` };
  }

  // X max tweet length is 280 chars
  const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;

  try {
    const tweet = await rw.v2.tweet(truncated);
    _lastPostedAt = Date.now();
    console.log(`[XPoster] Posted tweet ${tweet.data.id}: ${truncated.slice(0, 60)}...`);
    return { ok: true, tweetId: tweet.data.id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[XPoster] Failed to post tweet:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Have Flow compose and post a tweet autonomously.
 * Calls askFlow with context, posts the result.
 */
export async function flowPost(prompt: string): Promise<XPostResult> {
  const { askFlow } = await import('./flow-agent.js');
  const text = await askFlow('x-scheduler', prompt);
  if (!text) return { ok: false, error: 'Flow returned empty response' };
  return postTweet(text);
}
