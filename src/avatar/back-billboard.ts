/**
 * Back Billboard — curved wall + two curved TV screens (left & right panels).
 *
 * 220° arc, radius 2.2, matching the hex platform edge.
 * Each TV follows the wall curve using CylinderGeometry with a 60° arc.
 * Canvas textures drive the ad content — same system as the DJ booth front banner.
 */

import * as THREE from 'three';
import { type AdContent } from './ad-banner';

const DEG = Math.PI / 180;

// Wall geometry
const WALL_R    = 2.2;
const WALL_H    = 2.4;
const WALL_Y    = WALL_H / 2;
const WALL_SEGS = 72;

// Arc: 70° → 290°, sweeping right-front → back → left-front
const ARC_START = 70  * DEG;
const ARC_LEN   = 220 * DEG;

// TV placement — symmetric 20° either side of back-centre (180°), narrow arc so
// all 4 corners stay within the camera's ~41° horizontal FOV from (0,1.25,2.8)
const TV_ARC_SPAN  = 30 * DEG;
const TV_R         = WALL_R - 0.002;  // virtually on the wall surface
const TV_H         = 0.75;            // screen height
const TV_Y         = 1.62;            // locked position
const TV_SEGS      = 72;              // match wall segments — same curve

// Shifted outward a bit from previous 150°/210°
const RIGHT_TV_CENTRE = 141 * DEG;
const LEFT_TV_CENTRE  = 219 * DEG;

// Colours
const COL_CYAN    = 0x00d4ff;
const COL_MAGENTA = 0xff00aa;

// Canvas resolution
const CANVAS_W = 1024;
const CANVAS_H = 512;

// Ad timing
const FADE_DURATION = 0.6;
const DEFAULT_HOLD  = 8;
const SCROLL_SPEED  = 60;

// ── Public types ──────────────────────────────────────────────────────────────

export interface BackBannerRefs {
  mesh:     THREE.Mesh;
  showAd:   (ad: AdContent) => void;
  queueAds: (ads: AdContent[]) => void;
  clearAds: () => void;
  update:   (delta: number) => void;
}

export interface BackBillboardRefs {
  group:      THREE.Group;
  leftPanel:  BackBannerRefs;
  rightPanel: BackBannerRefs;
  update:     (delta: number) => void;
}

// ── Neon material helper ──────────────────────────────────────────────────────

function neonMat(color: number, opacity = 1.0): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending:   THREE.AdditiveBlending,
    depthWrite: false,
    fog:        false,
  });
}

// ── Curved TV panel factory ───────────────────────────────────────────────────

function createCurvedTV(group: THREE.Group, centreTheta: number): BackBannerRefs {
  const arcStart = centreTheta - TV_ARC_SPAN / 2;

  // Dark bezel — slightly taller/wider than the screen
  const bezelGeo = new THREE.CylinderGeometry(
    TV_R + 0.005, TV_R + 0.005,
    TV_H + 0.06, TV_SEGS, 1,
    true, arcStart - 0.015, TV_ARC_SPAN + 0.03,
  );
  const bezel = new THREE.Mesh(bezelGeo, new THREE.MeshBasicMaterial({
    color: 0x0a0a0a,
    side:  THREE.BackSide,
    fog:   false,
  }));
  bezel.position.y = TV_Y;
  group.add(bezel);

  // Neon bezel border (cyan glow around the screen edge)
  for (const [yOff, col] of [[TV_H / 2 + 0.03, COL_CYAN], [-TV_H / 2 - 0.03, COL_MAGENTA]] as [number, number][]) {
    const rimGeo = new THREE.CylinderGeometry(
      TV_R + 0.008, TV_R + 0.008, 0.012, TV_SEGS, 1,
      true, arcStart - 0.01, TV_ARC_SPAN + 0.02,
    );
    const rim = new THREE.Mesh(rimGeo, neonMat(col, 0.9));
    rim.position.y = TV_Y + yOff;
    group.add(rim);
  }

  // ── Canvas / texture ──────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter  = THREE.LinearFilter;
  texture.magFilter  = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  // Flip horizontally — CylinderGeometry with BackSide mirrors the UV
  texture.repeat.set(-1, 1);
  texture.offset.set(1, 0);

  // Screen mesh
  const screenGeo = new THREE.CylinderGeometry(
    TV_R, TV_R,
    TV_H, TV_SEGS, 1,
    true, arcStart, TV_ARC_SPAN,
  );
  const screenMat = new THREE.MeshBasicMaterial({
    map:  texture,
    side: THREE.BackSide,
    fog:  false,
  });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.name     = 'tv-screen';
  screen.position.y = TV_Y;
  group.add(screen);

  // ── Ad state ──────────────────────────────────────────────────────────────
  let adQueue: AdContent[]      = [];
  let currentAd: AdContent|null = null;
  let currentImage: HTMLImageElement|null = null;
  let holdTimer    = 0;
  let fadePhase: 'in'|'hold'|'out'|'idle' = 'idle';
  let fadeProgress = 0;
  let scrollOffset = 0;

  // ── Canvas rendering ──────────────────────────────────────────────────────

  function renderIdle(): void {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#030810';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Scanlines
    ctx.fillStyle = 'rgba(0,212,255,0.03)';
    for (let y = 0; y < CANVAS_H; y += 4) ctx.fillRect(0, y, CANVAS_W, 1);

    // Border
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(4, 4, CANVAS_W - 8, CANVAS_H - 8);
    ctx.globalAlpha = 1;

    // Idle ad slot branding
    ctx.font = 'bold 72px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#00d4ff';
    ctx.globalAlpha = 0.2;
    ctx.fillText('ADVERTISE HERE', CANVAS_W / 2, CANVAS_H / 2);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.8;
    ctx.fillText('ADVERTISE HERE', CANVAS_W / 2, CANVAS_H / 2);
    ctx.globalAlpha = 0.5;
    ctx.font = '28px Rajdhani, sans-serif';
    ctx.fillStyle = '#00d4ff';
    ctx.fillText('YOUR AD COULD BE HERE', CANVAS_W / 2, CANVAS_H / 2 + 55);
    ctx.globalAlpha = 1;

    texture.needsUpdate = true;
  }

  function renderAd(ad: AdContent, alpha: number): void {
    const bg     = ad.bgColor     || '#030810';
    const accent = ad.accentColor || '#00d4ff';

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Gradient overlay
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
    grad.addColorStop(0,   `${accent}35`);
    grad.addColorStop(0.5, `${accent}08`);
    grad.addColorStop(1,   '#ff00aa35');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Border
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.8 * alpha;
    ctx.strokeRect(3, 3, CANVAS_W - 6, CANVAS_H - 6);
    ctx.globalAlpha = alpha;

    // Image
    let textX = 40;
    if (currentImage?.complete && currentImage.naturalWidth > 0) {
      const ih  = CANVAS_H - 30;
      const iw  = (currentImage.naturalWidth / currentImage.naturalHeight) * ih;
      ctx.drawImage(currentImage, 15, 15, iw, ih);
      textX = 15 + iw + 20;
    }

    const areaW = CANVAS_W - textX - 20;

    // Headline
    ctx.font         = 'bold 58px Orbitron, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    const headY      = ad.body ? 35 : 105;
    const headW      = ctx.measureText(ad.headline).width;
    const scroll     = headW > areaW;

    const drawHead = (x: number) => {
      ctx.fillStyle  = accent;
      ctx.globalAlpha = 0.45 * alpha;
      ctx.fillText(ad.headline, x + 1, headY + 1);
      ctx.fillStyle  = '#ffffff';
      ctx.globalAlpha = alpha;
      ctx.fillText(ad.headline, x, headY);
    };

    if (scroll) {
      ctx.save();
      ctx.beginPath(); ctx.rect(textX, 0, areaW, CANVAS_H); ctx.clip();
      const total = headW + 120;
      drawHead(textX - (scrollOffset % total));
      drawHead(textX - (scrollOffset % total) + total);
      ctx.restore();
    } else {
      drawHead(textX);
    }

    // Body
    if (ad.body) {
      ctx.font        = 'bold 34px Rajdhani, sans-serif';
      ctx.fillStyle   = '#ffffff';
      ctx.globalAlpha = 0.85 * alpha;
      ctx.fillText(ad.body, textX, 125, areaW);
    }

    // Bottom bar
    ctx.fillStyle  = accent;
    ctx.globalAlpha = 0.65 * alpha;
    ctx.fillRect(8, CANVAS_H - 8, CANVAS_W - 16, 4);
    ctx.globalAlpha = 1;

    // Scanlines
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let y = 0; y < CANVAS_H; y += 3) ctx.fillRect(0, y, CANVAS_W, 1);

    texture.needsUpdate = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function showAd(ad: AdContent): void {
    currentAd    = ad;
    currentImage = null;
    fadePhase    = 'in';
    fadeProgress = 0;
    holdTimer    = 0;
    scrollOffset = 0;
    if (ad.imageUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { currentImage = img; };
      img.src = ad.imageUrl;
    }
  }

  function queueAds(ads: AdContent[]): void {
    adQueue = [...ads];
    if (!currentAd && adQueue.length > 0) showAd(adQueue.shift()!);
  }

  function clearAds(): void {
    adQueue = []; currentAd = null; currentImage = null;
    fadePhase = 'idle'; fadeProgress = 0;
    renderIdle();
  }

  function update(delta: number): void {
    switch (fadePhase) {
      case 'idle': return;
      case 'in':
        fadeProgress += delta / FADE_DURATION;
        if (fadeProgress >= 1) { fadeProgress = 1; fadePhase = 'hold'; holdTimer = 0; }
        if (currentAd) renderAd(currentAd, fadeProgress);
        break;
      case 'hold':
        holdTimer    += delta;
        scrollOffset += SCROLL_SPEED * delta;
        if (currentAd) renderAd(currentAd, 1);
        if (holdTimer >= (currentAd?.duration ?? DEFAULT_HOLD)) { fadePhase = 'out'; fadeProgress = 1; }
        break;
      case 'out':
        fadeProgress -= delta / FADE_DURATION;
        if (fadeProgress <= 0) {
          fadeProgress = 0; currentAd = null; currentImage = null;
          if (adQueue.length > 0) showAd(adQueue.shift()!);
          else { fadePhase = 'idle'; renderIdle(); }
        } else if (currentAd) renderAd(currentAd, fadeProgress);
        break;
    }
    (screen.material as THREE.MeshBasicMaterial).opacity =
      fadePhase === 'idle' ? 1 : fadeProgress;
  }

  renderIdle();

  return { mesh: screen, showAd, queueAds, clearAds, update };
}

// ── Main factory ──────────────────────────────────────────────────────────────

export function createBackBillboard(scene: THREE.Scene): BackBillboardRefs {
  const group = new THREE.Group();
  group.name = 'back-billboard';

  // ── Curved wall body ───────────────────────────────────────────────────────
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(WALL_R, WALL_R, WALL_H, WALL_SEGS, 1, true, ARC_START, ARC_LEN),
    new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, fog: false }),
  );
  wall.name       = 'back-wall';
  wall.position.y = WALL_Y;
  group.add(wall);

  // ── Neon top trim (cyan) ───────────────────────────────────────────────────
  const topTrim = new THREE.Mesh(
    new THREE.CylinderGeometry(WALL_R - 0.01, WALL_R - 0.01, 0.04, WALL_SEGS, 1, true, ARC_START, ARC_LEN),
    neonMat(COL_CYAN),
  );
  topTrim.position.y = WALL_H + 0.02;
  group.add(topTrim);

  // ── Neon bottom trim (magenta) ─────────────────────────────────────────────
  const botTrim = new THREE.Mesh(
    new THREE.CylinderGeometry(WALL_R - 0.01, WALL_R - 0.01, 0.04, WALL_SEGS, 1, true, ARC_START, ARC_LEN),
    neonMat(COL_MAGENTA),
  );
  botTrim.position.y = 0.02;
  group.add(botTrim);

  // ── Vertical end-cap neon strips ───────────────────────────────────────────
  for (const theta of [ARC_START, ARC_START + ARC_LEN]) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, WALL_H, 0.04),
      neonMat(COL_CYAN, 0.9),
    );
    strip.position.set(WALL_R * Math.sin(theta), WALL_Y, WALL_R * Math.cos(theta));
    group.add(strip);
  }

  // ── Curved TV screens ─────────────────────────────────────────────────────
  const rightPanel = createCurvedTV(group, RIGHT_TV_CENTRE);
  const leftPanel  = createCurvedTV(group, LEFT_TV_CENTRE);

  scene.add(group);

  return {
    group,
    leftPanel,
    rightPanel,
    update: (delta) => {
      leftPanel.update(delta);
      rightPanel.update(delta);
    },
  };
}
