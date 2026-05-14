/**
 * Dynamic advertisement banner for the DJ booth front facade.
 * Uses a canvas texture mapped onto the booth's front panel,
 * supporting live text, images, and scroll/fade transitions.
 *
 * The AI agent pushes ad content via showAd() and the banner
 * renders it with smooth transitions in the render loop.
 */

import * as THREE from 'three';

// ── Canvas / texture dimensions ─────────────────────────────────
const CANVAS_W = 1024;
const CANVAS_H = 256;

// ── Transition timing ───────────────────────────────────────────
const FADE_DURATION = 0.6;      // seconds for fade in/out
const DEFAULT_HOLD = 8;         // seconds to hold an ad before cycling
const SCROLL_SPEED = 60;        // pixels/sec for scrolling text

// ── NeoFlux palette for the banner ──────────────────────────────
const BG_COLOR = '#030810';
const TEXT_COLOR = '#ffffff';
const ACCENT_COLOR = '#00d4ff';
const SECONDARY_COLOR = '#ff00aa';
const BORDER_COLOR = '#00d4ff';

export interface AdContent {
  /** Main headline text */
  headline: string;
  /** Optional smaller body/tagline text */
  body?: string;
  /** Optional image URL (loaded async) */
  imageUrl?: string;
  /** How long to display in seconds (default: 8) */
  duration?: number;
  /** Background color override (CSS color string) */
  bgColor?: string;
  /** Accent color override for border/highlights */
  accentColor?: string;
}

export interface AdBannerRefs {
  /** The Three.js mesh for the banner panel */
  mesh: THREE.Mesh;
  /** The canvas texture (auto-updated) */
  texture: THREE.CanvasTexture;
  /** Push a new ad to display */
  showAd: (ad: AdContent) => void;
  /** Queue multiple ads for rotation */
  queueAds: (ads: AdContent[]) => void;
  /** Clear all ads, show idle state */
  clearAds: () => void;
  /** Call every frame with delta time */
  update: (delta: number) => void;
}

/**
 * Create the ad banner system.
 * Returns refs for the mesh + control API.
 */
export function createAdBanner(): AdBannerRefs {
  // ── Canvas setup ──────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  // ── Mesh (replaces the static facade) ─────────────────────────
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1), // sized by caller
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
    }),
  );
  mesh.name = 'ad-banner';

  // ── State ─────────────────────────────────────────────────────
  let adQueue: AdContent[] = [];
  let currentAd: AdContent | null = null;
  let currentImage: HTMLImageElement | null = null;
  let holdTimer = 0;
  let fadePhase: 'in' | 'hold' | 'out' | 'idle' = 'idle';
  let fadeProgress = 0;
  let scrollOffset = 0;

  // ── Render the canvas ─────────────────────────────────────────

  function renderIdle(): void {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Dark background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Bright neon border
    ctx.strokeStyle = ACCENT_COLOR;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(4, 4, CANVAS_W - 8, CANVAS_H - 8);
    ctx.globalAlpha = 1;

    // Bright "CLAW DJ" branding — highly visible
    ctx.font = 'bold 64px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Glow layer (drawn twice for bloom effect)
    ctx.fillStyle = ACCENT_COLOR;
    ctx.globalAlpha = 0.3;
    ctx.fillText('CLAW DJ', CANVAS_W / 2, CANVAS_H / 2);
    // Crisp white layer on top
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9;
    ctx.fillText('CLAW DJ', CANVAS_W / 2, CANVAS_H / 2);
    ctx.globalAlpha = 1;

    // Tagline below
    ctx.font = '24px Rajdhani, sans-serif';
    ctx.fillStyle = ACCENT_COLOR;
    ctx.globalAlpha = 0.6;
    ctx.fillText('LIVE  \u2022  NOW STREAMING', CANVAS_W / 2, CANVAS_H / 2 + 45);
    ctx.globalAlpha = 1;

    // Scanline effect
    ctx.fillStyle = 'rgba(0, 212, 255, 0.03)';
    for (let y = 0; y < CANVAS_H; y += 4) {
      ctx.fillRect(0, y, CANVAS_W, 1);
    }

    texture.needsUpdate = true;
  }

  function renderAd(ad: AdContent, alpha: number): void {
    const bg = ad.bgColor || BG_COLOR;
    const accent = ad.accentColor || ACCENT_COLOR;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Vivid gradient overlay (neon glow across the panel)
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
    grad.addColorStop(0, `${accent}30`);
    grad.addColorStop(0.4, `${accent}08`);
    grad.addColorStop(0.6, `${SECONDARY_COLOR}08`);
    grad.addColorStop(1, `${SECONDARY_COLOR}30`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Bright neon border
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.8 * alpha;
    ctx.strokeRect(3, 3, CANVAS_W - 6, CANVAS_H - 6);
    ctx.globalAlpha = alpha;

    // Image (if loaded, draw on the left side)
    let textStartX = 40;
    if (currentImage && currentImage.complete && currentImage.naturalWidth > 0) {
      const imgH = CANVAS_H - 30;
      const imgW = (currentImage.naturalWidth / currentImage.naturalHeight) * imgH;
      const imgX = 15;
      const imgY = 15;
      ctx.drawImage(currentImage, imgX, imgY, imgW, imgH);
      textStartX = imgX + imgW + 20;
    }

    const textAreaW = CANVAS_W - textStartX - 20;

    // Headline — BRIGHT white with cyan glow for maximum visibility
    ctx.font = 'bold 46px Orbitron, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const headlineText = ad.headline;
    const headlineMetrics = ctx.measureText(headlineText);
    const needsScroll = headlineMetrics.width > textAreaW;
    const headlineY = ad.body ? 30 : 85;

    const drawHeadline = (x: number, y: number) => {
      // Glow layer (cyan shadow behind text)
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.5 * alpha;
      ctx.fillText(headlineText, x + 1, y + 1);
      // Bright white text on top
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 1.0 * alpha;
      ctx.fillText(headlineText, x, y);
    };

    if (needsScroll) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(textStartX, 0, textAreaW, CANVAS_H);
      ctx.clip();
      const totalW = headlineMetrics.width + 120;
      const x = textStartX - (scrollOffset % totalW);
      drawHeadline(x, headlineY);
      drawHeadline(x + totalW, headlineY);
      ctx.restore();
    } else {
      drawHeadline(textStartX, headlineY);
    }

    // Body text — bright cyan, fully visible
    if (ad.body) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.4 * alpha;
      ctx.font = 'bold 30px Rajdhani, sans-serif';
      ctx.fillText(ad.body, textStartX + 1, 101);
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.9 * alpha;
      ctx.fillText(ad.body, textStartX, 100, textAreaW);
      ctx.globalAlpha = alpha;
    }

    // Bottom accent bar (bright)
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.7 * alpha;
    ctx.fillRect(8, CANVAS_H - 8, CANVAS_W - 16, 4);

    // Top accent bar
    ctx.fillRect(8, 4, CANVAS_W - 16, 2);
    ctx.globalAlpha = alpha;

    // LED indicator dots (bright)
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 === 0 ? accent : SECONDARY_COLOR;
      ctx.globalAlpha = 0.7 * alpha;
      ctx.beginPath();
      ctx.arc(CANVAS_W - 30 - i * 18, 18, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Scanline overlay (very subtle)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    for (let y = 0; y < CANVAS_H; y += 3) {
      ctx.fillRect(0, y, CANVAS_W, 1);
    }

    texture.needsUpdate = true;
  }

  // ── Public API ────────────────────────────────────────────────

  function showAd(ad: AdContent): void {
    currentAd = ad;
    currentImage = null;
    fadePhase = 'in';
    fadeProgress = 0;
    holdTimer = 0;
    scrollOffset = 0;

    // Load image async if provided
    if (ad.imageUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        currentImage = img;
      };
      img.src = ad.imageUrl;
    }
  }

  function queueAds(ads: AdContent[]): void {
    adQueue = [...ads];
    if (!currentAd && adQueue.length > 0) {
      showAd(adQueue.shift()!);
    }
  }

  function clearAds(): void {
    adQueue = [];
    currentAd = null;
    currentImage = null;
    fadePhase = 'idle';
    fadeProgress = 0;
    renderIdle();
  }

  function update(delta: number): void {
    switch (fadePhase) {
      case 'idle':
        // Nothing active — idle screen already rendered
        return;

      case 'in':
        fadeProgress += delta / FADE_DURATION;
        if (fadeProgress >= 1) {
          fadeProgress = 1;
          fadePhase = 'hold';
          holdTimer = 0;
        }
        if (currentAd) renderAd(currentAd, fadeProgress);
        break;

      case 'hold':
        holdTimer += delta;
        scrollOffset += SCROLL_SPEED * delta;
        if (currentAd) renderAd(currentAd, 1);
        if (holdTimer >= (currentAd?.duration ?? DEFAULT_HOLD)) {
          fadePhase = 'out';
          fadeProgress = 1;
        }
        break;

      case 'out':
        fadeProgress -= delta / FADE_DURATION;
        if (fadeProgress <= 0) {
          fadeProgress = 0;
          currentAd = null;
          currentImage = null;
          // Cycle to next ad in queue, or back to idle
          if (adQueue.length > 0) {
            showAd(adQueue.shift()!);
          } else {
            fadePhase = 'idle';
            renderIdle();
          }
        } else if (currentAd) {
          renderAd(currentAd, fadeProgress);
        }
        break;
    }

    // Update material opacity for fade
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = fadePhase === 'idle' ? 1 : fadeProgress;
  }

  // Initial idle render
  renderIdle();

  return { mesh, texture, showAd, queueAds, clearAds, update };
}
