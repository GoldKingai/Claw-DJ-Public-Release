/**
 * Ad Placement Routes
 *
 * GET  /api/ads/pricing          — pricing table for all slots + duration tiers
 * POST /api/ads/book             — book an ad slot
 * GET  /api/ads/stream           — SSE stream of slot events (for display client)
 * GET  /api/ads/state            — snapshot of all 3 slot states
 * POST /api/ads/cancel/:id       — cancel an active/queued booking (admin)
 *
 * Slots:
 *   1 — DJ Booth front banner  (premium)
 *   2 — Back Left TV screen
 *   3 — Back Right TV screen
 */

import { Router, type Request, type Response } from 'express';
import { adManager, AD_TIERS, SLOT_LABELS, type AdSlot } from '../services/ad-manager.js';

const router = Router();

// ── Pricing table ─────────────────────────────────────────────────────────────

router.get('/pricing', (_req: Request, res: Response) => {
  res.json({
    slots: SLOT_LABELS,
    tiers: AD_TIERS.map(t => ({
      key:         t.key,
      label:       t.label,
      durationSecs: t.durationSecs,
      displaySecs:  t.displaySecs,
      prices: {
        1: { pence: t.pricePence[1], display: `£${(t.pricePence[1] / 100).toFixed(2)}` },
        2: { pence: t.pricePence[2], display: `£${(t.pricePence[2] / 100).toFixed(2)}` },
        3: { pence: t.pricePence[3], display: `£${(t.pricePence[3] / 100).toFixed(2)}` },
      },
    })),
  });
});

// ── Book a slot ───────────────────────────────────────────────────────────────

/**
 * POST /api/ads/book
 * Body: {
 *   slot: 1 | 2 | 3,
 *   headline: string,
 *   body?: string,
 *   imageUrl?: string,
 *   bgColor?: string,
 *   accentColor?: string,
 *   durationSecs: number,   // must match a tier's durationSecs
 *   displaySecs?: number,   // override per-appearance duration
 * }
 */
router.post('/book', (req: Request, res: Response) => {
  const {
    slot, headline, body, imageUrl, bgColor, accentColor,
    durationSecs, displaySecs,
  } = req.body as {
    slot?: number;
    headline?: string;
    body?: string;
    imageUrl?: string;
    bgColor?: string;
    accentColor?: string;
    durationSecs?: number;
    displaySecs?: number;
  };

  if (!slot || ![1, 2, 3].includes(slot)) {
    res.status(400).json({ ok: false, error: 'slot must be 1, 2, or 3' });
    return;
  }
  if (!headline?.trim()) {
    res.status(400).json({ ok: false, error: 'headline required' });
    return;
  }
  if (typeof durationSecs !== 'number' || durationSecs <= 0) {
    res.status(400).json({ ok: false, error: 'durationSecs required (use a value from /api/ads/pricing)' });
    return;
  }

  const tier = AD_TIERS.find(t => t.durationSecs === durationSecs);
  if (!tier) {
    res.status(400).json({
      ok: false,
      error: `durationSecs must be one of: ${AD_TIERS.map(t => t.durationSecs).join(', ')}`,
    });
    return;
  }

  const booking = adManager.book({
    slot:        slot as AdSlot,
    headline,
    body,
    imageUrl,
    bgColor,
    accentColor,
    durationSecs,
    displaySecs: typeof displaySecs === 'number' && displaySecs > 0 ? displaySecs : undefined,
  });

  const price = tier.pricePence[slot as AdSlot];

  res.json({
    ok:      true,
    booking,
    price: {
      pence:   price,
      display: `£${(price / 100).toFixed(2)}`,
    },
    tier: { key: tier.key, label: tier.label },
  });
});

// ── SSE stream ─────────────────────────────────────────────────────────────────

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  adManager.addClient(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    adManager.removeClient(send);
  });
});

// ── State snapshot ─────────────────────────────────────────────────────────────

router.get('/state', (_req: Request, res: Response) => {
  res.json({ slots: adManager.getAllState() });
});

// ── Cancel booking ─────────────────────────────────────────────────────────────

router.post('/cancel/:id', (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const cancelled = adManager.cancel(id);
  if (!cancelled) {
    res.status(404).json({ ok: false, error: 'booking not found or already expired' });
    return;
  }
  res.json({ ok: true });
});

export default router;
