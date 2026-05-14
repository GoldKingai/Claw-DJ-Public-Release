/**
 * Futuristic AI DJ booth built with Three.js.
 * Positioned in front of the avatar at waist height.
 *
 * Design: Beveled wedge body, holographic jog wheels with chasing LEDs,
 * animated waveform display, reactive pads, circuit traces, floating
 * holographic rings, and a dynamic front ad banner.
 */

import * as THREE from 'three';
import { createAdBanner, type AdBannerRefs, type AdContent } from './ad-banner';

// ── Dimensions ──────────────────────────────────────────────────
const DECK_WIDTH = 1.3;
const DECK_DEPTH = 0.55;
const DECK_HEIGHT = 0.05;
const DECK_Y = 0.88;
const DECK_Z = 0.55;

const JOG_RADIUS = 0.19;
const JOG_HEIGHT = 0.025;
const JOG_OFFSET_X = 0.42;
const JOG_OFFSET_Z = 0.04;

const LED_SEGMENTS = 24;
const FACADE_HEIGHT = 0.35;

// ── Palette ─────────────────────────────────────────────────────
const COL_BODY       = 0x080e1a;
const COL_BODY_GLOSS = 0x0a1225;
const COL_JOG_RIM    = 0x8899aa;
const COL_PLATTER    = 0x040a14;
const COL_ACCENT     = 0x00d4ff;
const COL_MAGENTA    = 0xff00aa;
const COL_VIOLET     = 0x8b5cf6;
const COL_LIME       = 0x00ff66;
const COL_FADER_SLOT = 0x060c18;
const COL_KNOB       = 0x1a2540;

export type { AdContent };

export interface DJBoothRefs {
  group: THREE.Group;
  jogLeft: THREE.Mesh;
  jogRight: THREE.Mesh;
  adBanner: AdBannerRefs;
  update: (delta: number, bpm: number) => void;
}

// ── Animation state ─────────────────────────────────────────────
interface BoothAnimState {
  elapsed: number;
  ledChaseAngle: number;
  padFlashStates: number[];  // decay timers per pad (16 total)
  waveformCtx: CanvasRenderingContext2D;
  waveformTex: THREE.CanvasTexture;
  circuitCtx: CanvasRenderingContext2D;
  circuitTex: THREE.CanvasTexture;
  circuitDotPos: number;
  lastBeatTime: number;
}

// ═════════════════════════════════════════════════════════════════
// MAIN FACTORY
// ═════════════════════════════════════════════════════════════════

export function createDJBooth(scene: THREE.Scene): DJBoothRefs {
  const group = new THREE.Group();
  group.name = 'dj-booth';
  group.position.set(0, DECK_Y, DECK_Z);

  // ── Step 1: Sculpted body ───────────────────────────────────
  buildSculptedBody(group);

  // ── Step 6: Circuit trace overlay on top surface ────────────
  const { ctx: circuitCtx, tex: circuitTex } = buildCircuitTraceOverlay(group);

  // ── Neon LED edge lights ────────────────────────────────────
  const neonEdges = buildNeonEdgeLights(group);

  // ── Step 2: Holographic jog wheels ──────────────────────────
  const { jogMesh: jogLeft, ledRing: ledRingL } = createHoloJogWheel('jog-left');
  jogLeft.position.set(-JOG_OFFSET_X, DECK_HEIGHT / 2 + 0.002, JOG_OFFSET_Z);
  group.add(jogLeft);

  const { jogMesh: jogRight, ledRing: ledRingR } = createHoloJogWheel('jog-right');
  jogRight.position.set(JOG_OFFSET_X, DECK_HEIGHT / 2 + 0.002, JOG_OFFSET_Z);
  group.add(jogRight);

  // ── Step 7: Holographic effects ─────────────────────────────
  const holoRings = buildHolographicEffects(group);

  // ── Mixer ───────────────────────────────────────────────────
  buildMixerSection(group);

  // ── Step 4: Reactive performance pads ───────────────────────
  const padMeshes = buildReactivePads(group);

  // ── Transport buttons ───────────────────────────────────────
  buildTransportButtons(group, -0.42);
  buildTransportButtons(group, 0.42);

  // ── Step 3: Animated center display ─────────────────────────
  const { ctx: waveCtx, tex: waveTex } = buildAnimatedDisplay(group);

  // ── Tempo faders ────────────────────────────────────────────
  buildTempoFader(group, -0.56);
  buildTempoFader(group, 0.56);

  // ── Step 5: Angular stand + ad banner ───────────────────────
  const adBanner = buildAngularStand(group);

  scene.add(group);

  // ── Animation state ─────────────────────────────────────────
  const anim: BoothAnimState = {
    elapsed: 0,
    ledChaseAngle: 0,
    padFlashStates: new Array(16).fill(0),
    waveformCtx: waveCtx,
    waveformTex: waveTex,
    circuitCtx,
    circuitTex,
    circuitDotPos: 0,
    lastBeatTime: 0,
  };

  // ── Update loop ─────────────────────────────────────────────
  const update = (delta: number, bpm: number) => {
    anim.elapsed += delta;
    const beatInterval = 60 / bpm;
    const beatPhase = (anim.elapsed % beatInterval) / beatInterval;

    // Jog wheel spinning
    const rotSpeed = ((bpm / 2) / 60) * Math.PI * 2 * delta;
    jogLeft.rotation.y -= rotSpeed;
    jogRight.rotation.y -= rotSpeed;

    // Step 2: Chasing LED ring
    anim.ledChaseAngle += delta * (bpm / 60) * Math.PI * 2;
    updateLedRing(ledRingL, anim.ledChaseAngle);
    updateLedRing(ledRingR, anim.ledChaseAngle + Math.PI);

    // Step 3: Animated waveform display
    updateWaveformCanvas(anim.waveformCtx, anim.waveformTex, anim.elapsed, bpm);

    // Step 4: Reactive pads (flash on beat)
    const isNewBeat = anim.elapsed - anim.lastBeatTime >= beatInterval;
    if (isNewBeat) {
      anim.lastBeatTime = anim.elapsed;
      // Trigger 1-2 random pads
      const count = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * 16);
        anim.padFlashStates[idx] = 1.0;
      }
    }
    updatePadFlashes(padMeshes, anim.padFlashStates, delta);

    // Step 6: Circuit trace animation
    anim.circuitDotPos += delta * (bpm / 60) * 80;
    updateCircuitTraces(anim.circuitCtx, anim.circuitTex, anim.circuitDotPos);

    // Step 7: Holographic rings spin with jog wheels
    for (let i = 0; i < holoRings.length; i++) {
      const ring = holoRings[i];
      // Outer rings (even indices) spin with platters, inner rings counter-rotate
      const dir = i % 2 === 0 ? -1 : 1;
      ring.rotation.z += rotSpeed * dir;
    }

    // Neon pulse to beat
    const pulse = 0.6 + Math.max(0, (1 - beatPhase * 3)) * 0.4;
    for (const neon of neonEdges) {
      (neon.material as THREE.MeshBasicMaterial).opacity = pulse * 0.85;
    }

    // Ad banner
    adBanner.update(delta);
  };

  return { group, jogLeft, jogRight, adBanner, update };
}

// ═════════════════════════════════════════════════════════════════
// STEP 1: SCULPTED BODY
// ═════════════════════════════════════════════════════════════════

function buildSculptedBody(group: THREE.Group): void {
  // Wedge profile: thicker at back, thinner at front, beveled top edge
  const hw = DECK_WIDTH / 2;
  const hd = DECK_DEPTH / 2;
  const backH = DECK_HEIGHT;
  const frontH = DECK_HEIGHT * 0.6;
  const bevel = 0.012;

  const shape = new THREE.Shape();
  // Cross-section from side view (Z-Y plane): trapezoid with beveled top
  shape.moveTo(-hd, 0);                       // bottom-front
  shape.lineTo(hd, 0);                        // bottom-back
  shape.lineTo(hd, backH - bevel);            // up back wall
  shape.lineTo(hd - bevel, backH);            // bevel at back-top
  shape.lineTo(-hd + bevel, frontH);          // angled top surface
  shape.lineTo(-hd, frontH - bevel);          // bevel at front-top
  shape.closePath();

  const extrudeSettings = {
    depth: DECK_WIDTH,
    bevelEnabled: false,
  };
  const bodyGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  // ExtrudeGeometry extrudes along Z by default; we need to rotate + center
  bodyGeo.rotateY(Math.PI / 2);
  bodyGeo.translate(0, 0, 0);
  bodyGeo.center();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: COL_BODY,
    roughness: 0.15,
    metalness: 0.85,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = 'deck-body';
  group.add(body);

  // Glass panel overlay on top surface
  const glassGeo = new THREE.PlaneGeometry(DECK_WIDTH - 0.03, DECK_DEPTH - 0.03);
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a1530,
    roughness: 0.05,
    metalness: 0.3,
    transparent: true,
    opacity: 0.35,
    transmission: 0.2,
  });
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.rotation.x = -Math.PI / 2;
  glass.position.y = DECK_HEIGHT / 2 + 0.003;
  glass.name = 'deck-glass-panel';
  group.add(glass);
}

// ═════════════════════════════════════════════════════════════════
// STEP 2: HOLOGRAPHIC JOG WHEELS
// ═════════════════════════════════════════════════════════════════

interface JogWheelResult {
  jogMesh: THREE.Mesh;
  ledRing: THREE.Mesh[];
}

function createHoloJogWheel(name: string): JogWheelResult {
  const jogGroup = new THREE.Group() as unknown as THREE.Mesh;
  const ledRing: THREE.Mesh[] = [];

  // Chrome outer torus rim (kept from original — premium look)
  const outerRimGeo = new THREE.TorusGeometry(JOG_RADIUS, 0.012, 16, 48);
  const outerRimMat = new THREE.MeshStandardMaterial({
    color: COL_JOG_RIM,
    roughness: 0.12,
    metalness: 0.95,
  });
  const outerRim = new THREE.Mesh(outerRimGeo, outerRimMat);
  outerRim.rotation.x = -Math.PI / 2;
  outerRim.position.y = JOG_HEIGHT / 2 + 0.003;
  jogGroup.add(outerRim);

  // Chasing LED ring — 24 arc segments around the rim
  const segAngle = (Math.PI * 2) / LED_SEGMENTS;
  for (let i = 0; i < LED_SEGMENTS; i++) {
    const arcGeo = new THREE.RingGeometry(
      JOG_RADIUS + 0.014,
      JOG_RADIUS + 0.024,
      8,
      1,
      i * segAngle + 0.02,
      segAngle - 0.04,
    );
    const arcMat = new THREE.MeshBasicMaterial({
      color: COL_ACCENT,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.rotation.x = -Math.PI / 2;
    arc.position.y = JOG_HEIGHT / 2 + 0.005;
    jogGroup.add(arc);
    ledRing.push(arc);
  }

  // Base platter
  const platterGeo = new THREE.CylinderGeometry(JOG_RADIUS - 0.005, JOG_RADIUS - 0.005, JOG_HEIGHT, 48);
  const platterMat = new THREE.MeshStandardMaterial({
    color: COL_PLATTER,
    roughness: 0.4,
    metalness: 0.7,
  });
  const platter = new THREE.Mesh(platterGeo, platterMat);
  jogGroup.add(platter);

  // Holographic center hub (iridescent)
  const hubGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.012, 32);
  const hubMat = new THREE.MeshPhysicalMaterial({
    color: 0x2244aa,
    roughness: 0.05,
    metalness: 0.9,
    iridescence: 1.0,
    iridescenceIOR: 1.3,
  });
  const hub = new THREE.Mesh(hubGeo, hubMat);
  hub.position.y = JOG_HEIGHT / 2 + 0.005;
  jogGroup.add(hub);

  // Center accent dot
  const dotGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.014, 16);
  const dotMat = new THREE.MeshBasicMaterial({
    color: COL_ACCENT,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
  });
  const dot = new THREE.Mesh(dotGeo, dotMat);
  dot.position.y = JOG_HEIGHT / 2 + 0.007;
  jogGroup.add(dot);

  // Concentric groove rings
  for (let r = 0; r < 5; r++) {
    const ringR = 0.055 + r * 0.025;
    const grooveGeo = new THREE.TorusGeometry(ringR, 0.001, 4, 48);
    const grooveMat = new THREE.MeshBasicMaterial({
      color: COL_ACCENT,
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
    });
    const groove = new THREE.Mesh(grooveGeo, grooveMat);
    groove.rotation.x = -Math.PI / 2;
    groove.position.y = JOG_HEIGHT / 2 + 0.004;
    jogGroup.add(groove);
  }

  // Position marker tick
  const tickGeo = new THREE.BoxGeometry(0.003, 0.005, 0.028);
  const tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tick = new THREE.Mesh(tickGeo, tickMat);
  tick.position.set(0, JOG_HEIGHT / 2 + 0.005, JOG_RADIUS - 0.045);
  jogGroup.add(tick);

  jogGroup.name = name;
  return { jogMesh: jogGroup, ledRing };
}

function updateLedRing(ledRing: THREE.Mesh[], chaseAngle: number): void {
  const segAngle = (Math.PI * 2) / LED_SEGMENTS;
  for (let i = 0; i < ledRing.length; i++) {
    const segCenter = i * segAngle;
    const dist = Math.abs(((chaseAngle % (Math.PI * 2)) - segCenter + Math.PI) % (Math.PI * 2) - Math.PI);
    const brightness = Math.max(0.05, 1.0 - dist * 1.2);
    const mat = ledRing[i].material as THREE.MeshBasicMaterial;
    mat.opacity = brightness * 0.7;
    // Color shift: cyan near the chase point, magenta trailing
    const t = Math.max(0, 1 - dist * 2);
    mat.color.setHex(t > 0.5 ? COL_ACCENT : COL_MAGENTA);
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 3: ANIMATED CENTER DISPLAY
// ═════════════════════════════════════════════════════════════════

function buildAnimatedDisplay(group: THREE.Group): { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const yTop = DECK_HEIGHT / 2 + 0.003;
  const screenW = 0.52;
  const screenD = 0.12;

  // Hover gap glow (beneath floating screen)
  const hoverGlowGeo = new THREE.PlaneGeometry(screenW - 0.02, screenD - 0.02);
  const hoverGlowMat = new THREE.MeshBasicMaterial({
    color: COL_ACCENT,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const hoverGlow = new THREE.Mesh(hoverGlowGeo, hoverGlowMat);
  hoverGlow.rotation.x = -Math.PI / 2;
  hoverGlow.position.set(0, yTop + 0.008, -0.20);
  group.add(hoverGlow);

  // Canvas for animated waveform
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  // Floating screen with canvas texture
  const screenGeo = new THREE.PlaneGeometry(screenW, screenD);
  const screenMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.95,
  });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.rotation.x = -Math.PI / 2;
  screen.position.set(0, yTop + 0.028, -0.20); // raised/floating
  screen.name = 'center-display';
  group.add(screen);

  // Emissive border frame
  const frameMat = new THREE.MeshBasicMaterial({
    color: COL_ACCENT,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // Top/bottom borders
  for (const zOff of [-screenD / 2, screenD / 2]) {
    const borderGeo = new THREE.BoxGeometry(screenW + 0.01, 0.003, 0.004);
    const border = new THREE.Mesh(borderGeo, frameMat.clone());
    border.position.set(0, yTop + 0.028, -0.20 + zOff);
    group.add(border);
  }
  // Left/right borders
  for (const xOff of [-screenW / 2, screenW / 2]) {
    const borderGeo = new THREE.BoxGeometry(0.004, 0.003, screenD + 0.01);
    const border = new THREE.Mesh(borderGeo, frameMat.clone());
    border.position.set(xOff, yTop + 0.028, -0.20);
    group.add(border);
  }

  // Initial render
  updateWaveformCanvas(ctx, tex, 0, 128);

  return { ctx, tex };
}

function updateWaveformCanvas(ctx: CanvasRenderingContext2D, tex: THREE.CanvasTexture, elapsed: number, bpm: number): void {
  const w = 512;
  const h = 128;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#020610';
  ctx.fillRect(0, 0, w, h);

  // Waveform bars — 32 bars per half (deck A top, deck B bottom)
  const barCount = 48;
  const barW = (w - 20) / barCount;
  const beatPhase = (elapsed * bpm / 60) % 1;

  for (let i = 0; i < barCount; i++) {
    const x = 10 + i * barW;

    // Deck A (top half) — cyan
    const heightA = 8 + Math.random() * 40 + Math.sin(elapsed * 3 + i * 0.3) * 12;
    const gradA = ctx.createLinearGradient(x, h / 2 - heightA, x, h / 2);
    gradA.addColorStop(0, '#00f0ff');
    gradA.addColorStop(1, '#004466');
    ctx.fillStyle = gradA;
    ctx.fillRect(x, h / 2 - heightA, barW - 1, heightA);

    // Deck B (bottom half) — magenta
    const heightB = 8 + Math.random() * 35 + Math.cos(elapsed * 2.5 + i * 0.4) * 10;
    const gradB = ctx.createLinearGradient(x, h / 2, x, h / 2 + heightB);
    gradB.addColorStop(0, '#660033');
    gradB.addColorStop(1, '#ff00aa');
    ctx.fillStyle = gradB;
    ctx.fillRect(x, h / 2, barW - 1, heightB);
  }

  // Center line
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.3;
  ctx.fillRect(0, h / 2 - 0.5, w, 1);
  ctx.globalAlpha = 1;

  // Playhead (pulsing)
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.5 + beatPhase * 0.3;
  ctx.fillRect(w / 2 - 1, 2, 2, h - 4);
  ctx.globalAlpha = 1;

  // BPM readout
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#00f0ff';
  ctx.textAlign = 'left';
  ctx.fillText(`${bpm.toFixed(0)} BPM`, 12, 18);
  ctx.fillStyle = '#ff00aa';
  ctx.textAlign = 'right';
  ctx.fillText(`${bpm.toFixed(0)} BPM`, w - 12, 18);

  // Deck labels
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#00f0ff';
  ctx.textAlign = 'left';
  ctx.fillText('DECK A', 12, h - 8);
  ctx.fillStyle = '#ff00aa';
  ctx.textAlign = 'right';
  ctx.fillText('DECK B', w - 12, h - 8);

  tex.needsUpdate = true;
}

// ═════════════════════════════════════════════════════════════════
// STEP 4: REACTIVE PERFORMANCE PADS
// ═════════════════════════════════════════════════════════════════

function buildReactivePads(group: THREE.Group): THREE.Mesh[] {
  const yTop = DECK_HEIGHT / 2 + 0.003;
  const padSize = 0.024;
  const padGap = 0.006;
  const allPads: THREE.Mesh[] = [];

  const colors = [
    COL_ACCENT, COL_MAGENTA, COL_VIOLET, COL_LIME,
    COL_ACCENT, COL_MAGENTA, COL_VIOLET, COL_LIME,
  ];

  for (const centerX of [-0.42, 0.42]) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const idx = row * 4 + col;
        const padGeo = new THREE.BoxGeometry(padSize, 0.007, padSize);
        const padMat = new THREE.MeshStandardMaterial({
          color: 0x0a1225,
          emissive: colors[idx],
          emissiveIntensity: 0.15,
          roughness: 0.3,
          metalness: 0.6,
        });
        const pad = new THREE.Mesh(padGeo, padMat);
        const px = centerX + (col - 1.5) * (padSize + padGap);
        const pz = -0.14 + row * (padSize + padGap);
        pad.position.set(px, yTop + 0.007, pz);
        pad.name = `pad-${centerX < 0 ? 'a' : 'b'}-${idx}`;
        group.add(pad);
        allPads.push(pad);

        // Glow plane beneath each pad
        const glowGeo = new THREE.PlaneGeometry(padSize + 0.008, padSize + 0.008);
        const glowMat = new THREE.MeshBasicMaterial({
          color: colors[idx],
          transparent: true,
          opacity: 0.04,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(px, yTop + 0.004, pz);
        group.add(glow);
      }
    }
  }

  return allPads;
}

function updatePadFlashes(pads: THREE.Mesh[], states: number[], delta: number): void {
  for (let i = 0; i < pads.length && i < states.length; i++) {
    if (states[i] > 0) {
      states[i] = Math.max(0, states[i] - delta * 3.3); // decay over ~0.3s
    }
    const mat = pads[i].material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.15 + states[i] * 0.65;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 5: ANGULAR STAND + AD BANNER
// ═════════════════════════════════════════════════════════════════

function buildAngularStand(group: THREE.Group): AdBannerRefs {
  const facadeW = DECK_WIDTH + 0.04;
  const topNarrow = 0.06; // how much narrower the bottom is on each side

  // Trapezoidal front facade using custom geometry
  const geo = new THREE.BufferGeometry();
  const hw = facadeW / 2;
  const bw = hw - topNarrow; // bottom half-width
  const facadeZ = DECK_DEPTH / 2 + 0.011;

  // Vertices for trapezoidal front face (facing +Z)
  const vertices = new Float32Array([
    // Front face (trapezoid)
    -hw,  -DECK_HEIGHT / 2,                    facadeZ,  // top-left
     hw,  -DECK_HEIGHT / 2,                    facadeZ,  // top-right
     bw,  -DECK_HEIGHT / 2 - FACADE_HEIGHT,   facadeZ,  // bottom-right
    -bw,  -DECK_HEIGHT / 2 - FACADE_HEIGHT,   facadeZ,  // bottom-left
    // Back face
    -hw,  -DECK_HEIGHT / 2,                    facadeZ - 0.02,
     hw,  -DECK_HEIGHT / 2,                    facadeZ - 0.02,
     bw,  -DECK_HEIGHT / 2 - FACADE_HEIGHT,   facadeZ - 0.02,
    -bw,  -DECK_HEIGHT / 2 - FACADE_HEIGHT,   facadeZ - 0.02,
  ]);
  const indices = [
    0,1,2,  0,2,3,   // front
    5,4,7,  5,7,6,   // back
    4,0,3,  4,3,7,   // left
    1,5,6,  1,6,2,   // right
    4,5,1,  4,1,0,   // top
    3,2,6,  3,6,7,   // bottom
  ];
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const facadeMat = new THREE.MeshStandardMaterial({
    color: 0x050a14,
    roughness: 0.3,
    metalness: 0.7,
  });
  const facade = new THREE.Mesh(geo, facadeMat);
  facade.name = 'deck-stand-facade';
  group.add(facade);

  // Ad Banner on the front face
  const adBanner = createAdBanner();
  adBanner.mesh.geometry.dispose();
  // Slightly smaller than facade to sit inside with margin
  adBanner.mesh.geometry = new THREE.PlaneGeometry(facadeW - 0.06, FACADE_HEIGHT - 0.04);
  adBanner.mesh.position.set(
    0,
    -DECK_HEIGHT / 2 - FACADE_HEIGHT / 2,
    facadeZ + 0.001,
  );
  adBanner.mesh.name = 'ad-banner-screen';
  group.add(adBanner.mesh);

  // Frosted glass side panels
  for (const side of [-1, 1]) {
    const sideGeo = new THREE.BoxGeometry(0.018, FACADE_HEIGHT + 0.01, DECK_DEPTH * 0.6);
    const sideMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a1830,
      roughness: 0.3,
      metalness: 0.4,
      transparent: true,
      opacity: 0.4,
      transmission: 0.3,
    });
    const sidePanel = new THREE.Mesh(sideGeo, sideMat);
    sidePanel.position.set(
      side * (DECK_WIDTH / 2 + 0.01),
      -(FACADE_HEIGHT / 2) - DECK_HEIGHT / 2,
      DECK_DEPTH * 0.1,
    );
    sidePanel.name = `stand-glass-${side > 0 ? 'r' : 'l'}`;
    group.add(sidePanel);
  }

  // Accent strips (top and bottom of ad area)
  const stripMat = new THREE.MeshBasicMaterial({
    color: COL_ACCENT,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const yOff of [-0.005, -FACADE_HEIGHT - 0.005]) {
    const stripGeo = new THREE.BoxGeometry(facadeW + 0.01, 0.006, 0.008);
    const strip = new THREE.Mesh(stripGeo, stripMat.clone());
    strip.position.set(0, -DECK_HEIGHT / 2 + yOff, facadeZ + 0.002);
    group.add(strip);
  }

  return adBanner;
}

// ═════════════════════════════════════════════════════════════════
// STEP 6: CIRCUIT TRACE OVERLAY
// ═════════════════════════════════════════════════════════════════

function buildCircuitTraceOverlay(group: THREE.Group): { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const overlayGeo = new THREE.PlaneGeometry(DECK_WIDTH - 0.06, DECK_DEPTH - 0.06);
  const overlayMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const overlay = new THREE.Mesh(overlayGeo, overlayMat);
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.y = DECK_HEIGHT / 2 + 0.005;
  overlay.name = 'circuit-trace-overlay';
  group.add(overlay);

  // Initial render
  updateCircuitTraces(ctx, tex, 0);

  return { ctx, tex };
}

// Pre-defined circuit trace paths (normalized 0-512 coordinates)
const CIRCUIT_PATHS: [number, number][][] = [
  [[50, 256], [150, 256], [180, 200], [300, 200], [330, 256], [460, 256]],
  [[256, 50], [256, 150], [200, 180], [200, 332], [256, 362], [256, 462]],
  [[80, 120], [200, 120], [230, 150], [230, 250], [200, 280], [80, 280]],
  [[432, 120], [312, 120], [282, 150], [282, 250], [312, 280], [432, 280]],
  [[100, 400], [200, 400], [256, 360], [312, 400], [412, 400]],
  [[50, 180], [120, 180], [150, 150], [180, 180], [256, 180]],
  [[256, 180], [332, 180], [362, 150], [392, 180], [462, 180]],
];

function updateCircuitTraces(ctx: CanvasRenderingContext2D, tex: THREE.CanvasTexture, dotPos: number): void {
  ctx.clearRect(0, 0, 512, 512);

  // Draw static trace lines
  ctx.strokeStyle = 'rgba(0, 212, 255, 0.12)';
  ctx.lineWidth = 1.5;
  for (const path of CIRCUIT_PATHS) {
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i][0], path[i][1]);
    }
    ctx.stroke();
  }

  // Draw traveling dots along traces
  for (let p = 0; p < CIRCUIT_PATHS.length; p++) {
    const path = CIRCUIT_PATHS[p];
    const offset = (dotPos + p * 40) % 300;

    // Calculate total path length
    let totalLen = 0;
    const segLens: number[] = [];
    for (let i = 1; i < path.length; i++) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      const len = Math.sqrt(dx * dx + dy * dy);
      segLens.push(len);
      totalLen += len;
    }

    const tNorm = (offset % totalLen) / totalLen;
    let accumulated = 0;
    for (let i = 0; i < segLens.length; i++) {
      const segFrac = segLens[i] / totalLen;
      if (accumulated + segFrac >= tNorm) {
        const localT = (tNorm - accumulated) / segFrac;
        const x = path[i][0] + (path[i + 1][0] - path[i][0]) * localT;
        const y = path[i][1] + (path[i + 1][1] - path[i][1]) * localT;

        // Bright dot
        const dotColor = p % 2 === 0 ? '#00f0ff' : '#ff00aa';
        ctx.fillStyle = dotColor;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        // Glow around dot
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      accumulated += segFrac;
    }
  }

  // Node points at path intersections
  const nodeSet = new Set<string>();
  for (const path of CIRCUIT_PATHS) {
    for (const pt of path) {
      const key = `${pt[0]},${pt[1]}`;
      if (!nodeSet.has(key)) {
        nodeSet.add(key);
        ctx.fillStyle = '#00d4ff';
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  tex.needsUpdate = true;
}

// ═════════════════════════════════════════════════════════════════
// STEP 7: HOLOGRAPHIC EFFECTS
// ═════════════════════════════════════════════════════════════════

function buildHolographicEffects(group: THREE.Group): THREE.Mesh[] {
  const holoRings: THREE.Mesh[] = [];
  const ringMat = new THREE.MeshBasicMaterial({
    color: COL_ACCENT,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Holographic accent rings around the jog wheels (at platter level)
  for (const xOff of [-JOG_OFFSET_X, JOG_OFFSET_X]) {
    // Outer holo ring — sits just outside the LED ring, flat on the deck
    const outerRingGeo = new THREE.TorusGeometry(JOG_RADIUS + 0.04, 0.003, 8, 48);
    const outerRing = new THREE.Mesh(outerRingGeo, ringMat.clone());
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.set(xOff, DECK_HEIGHT / 2 + 0.008, JOG_OFFSET_Z);
    outerRing.name = `holo-ring-${xOff < 0 ? 'l' : 'r'}-outer`;
    group.add(outerRing);
    holoRings.push(outerRing);

    // Inner holo ring — tighter around the hub, slightly tilted for holographic effect
    const innerRingGeo = new THREE.TorusGeometry(JOG_RADIUS * 0.45, 0.002, 8, 36);
    const innerRing = new THREE.Mesh(innerRingGeo, ringMat.clone());
    innerRing.rotation.x = -Math.PI / 2 + 0.15; // slight tilt
    innerRing.position.set(xOff, DECK_HEIGHT / 2 + 0.015, JOG_OFFSET_Z);
    innerRing.name = `holo-ring-${xOff < 0 ? 'l' : 'r'}-inner`;
    (innerRing.material as THREE.MeshBasicMaterial).color.setHex(COL_MAGENTA);
    (innerRing.material as THREE.MeshBasicMaterial).opacity = 0.07;
    group.add(innerRing);
    holoRings.push(innerRing);
  }

  // Enhanced under-glow (dual color)
  const glowGeo = new THREE.PlaneGeometry(DECK_WIDTH + 0.2, 0.4);
  for (const [color, opacity] of [[COL_ACCENT, 0.1], [COL_MAGENTA, 0.05]] as [number, number][]) {
    const glowMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(glowGeo.clone(), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, -DECK_HEIGHT / 2 - FACADE_HEIGHT - 0.02, DECK_DEPTH / 4);
    group.add(glow);
  }

  return holoRings;
}

// ═════════════════════════════════════════════════════════════════
// MIXER SECTION (upgraded materials)
// ═════════════════════════════════════════════════════════════════

function buildMixerSection(group: THREE.Group): void {
  const yTop = DECK_HEIGHT / 2 + 0.003;

  // Mixer raised panel (glossy)
  const mixerGeo = new THREE.BoxGeometry(0.28, 0.012, DECK_DEPTH - 0.06);
  const mixerMat = new THREE.MeshStandardMaterial({
    color: 0x0e1830,
    roughness: 0.15,
    metalness: 0.8,
  });
  const mixer = new THREE.Mesh(mixerGeo, mixerMat);
  mixer.position.set(0, yTop + 0.006, 0);
  group.add(mixer);

  // Channel faders
  for (let i = -1; i <= 1; i += 2) {
    const slotGeo = new THREE.BoxGeometry(0.015, 0.006, 0.12);
    const slotMat = new THREE.MeshStandardMaterial({ color: COL_FADER_SLOT, roughness: 0.6, metalness: 0.3 });
    const slot = new THREE.Mesh(slotGeo, slotMat);
    slot.position.set(i * 0.06, yTop + 0.013, 0.06);
    group.add(slot);

    const capGeo = new THREE.BoxGeometry(0.022, 0.01, 0.018);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.15, metalness: 0.85 });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(i * 0.06, yTop + 0.018, 0.06);
    group.add(cap);
  }

  // Crossfader
  const xfSlotGeo = new THREE.BoxGeometry(0.14, 0.005, 0.012);
  const xfSlot = new THREE.Mesh(xfSlotGeo, new THREE.MeshStandardMaterial({ color: COL_FADER_SLOT, roughness: 0.6, metalness: 0.3 }));
  xfSlot.position.set(0, yTop + 0.013, 0.16);
  group.add(xfSlot);

  const xfCapGeo = new THREE.BoxGeometry(0.025, 0.009, 0.018);
  const xfCap = new THREE.Mesh(xfCapGeo, new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.15, metalness: 0.85 }));
  xfCap.position.set(0, yTop + 0.017, 0.16);
  group.add(xfCap);

  // EQ knobs (3 per channel)
  for (const chX of [-0.06, 0.06]) {
    for (let k = 0; k < 3; k++) {
      const knobGeo = new THREE.CylinderGeometry(0.012, 0.013, 0.012, 16);
      const knobMat = new THREE.MeshStandardMaterial({ color: COL_KNOB, roughness: 0.2, metalness: 0.8 });
      const knob = new THREE.Mesh(knobGeo, knobMat);
      knob.position.set(chX, yTop + 0.018, -0.06 + k * 0.045);
      group.add(knob);

      // Cyan pointer
      const ptrGeo = new THREE.BoxGeometry(0.002, 0.003, 0.01);
      const ptr = new THREE.Mesh(ptrGeo, new THREE.MeshBasicMaterial({ color: COL_ACCENT }));
      ptr.position.set(chX, yTop + 0.025, -0.06 + k * 0.045);
      group.add(ptr);
    }
  }

  // Master knob
  const masterGeo = new THREE.CylinderGeometry(0.015, 0.016, 0.014, 16);
  const master = new THREE.Mesh(masterGeo, new THREE.MeshStandardMaterial({ color: COL_KNOB, roughness: 0.2, metalness: 0.8 }));
  master.position.set(0, yTop + 0.019, -0.1);
  group.add(master);

  // VU meter LEDs
  for (const chX of [-0.03, 0.03]) {
    for (let led = 0; led < 5; led++) {
      const ledGeo = new THREE.BoxGeometry(0.006, 0.004, 0.004);
      const ledColor = led < 3 ? COL_LIME : led < 4 ? 0xffaa00 : 0xff3333;
      const ledMat = new THREE.MeshStandardMaterial({
        color: ledColor,
        emissive: ledColor,
        emissiveIntensity: led < 3 ? 0.5 : 0.25,
        roughness: 0.3,
        metalness: 0.5,
      });
      const ledMesh = new THREE.Mesh(ledGeo, ledMat);
      ledMesh.position.set(chX, yTop + 0.015, -0.14 + led * 0.012);
      group.add(ledMesh);
    }
  }
}

// ═════════════════════════════════════════════════════════════════
// NEON EDGE LIGHTS (preserved from original)
// ═════════════════════════════════════════════════════════════════

function buildNeonEdgeLights(group: THREE.Group): THREE.Mesh[] {
  const neons: THREE.Mesh[] = [];

  const makeNeon = (color: number) => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  // Front
  const frontGeo = new THREE.BoxGeometry(DECK_WIDTH + 0.02, 0.012, 0.012);
  const frontNeon = new THREE.Mesh(frontGeo, makeNeon(0x00f0ff));
  frontNeon.position.set(0, DECK_HEIGHT / 2 + 0.002, DECK_DEPTH / 2 + 0.005);
  group.add(frontNeon);
  neons.push(frontNeon);

  // Back
  const backNeon = new THREE.Mesh(frontGeo.clone(), makeNeon(COL_MAGENTA));
  backNeon.position.set(0, DECK_HEIGHT / 2 + 0.002, -DECK_DEPTH / 2 - 0.005);
  group.add(backNeon);
  neons.push(backNeon);

  // Sides
  const sideGeo = new THREE.BoxGeometry(0.012, 0.012, DECK_DEPTH + 0.02);
  for (const side of [-1, 1]) {
    const sideNeon = new THREE.Mesh(sideGeo.clone(), makeNeon(side === -1 ? 0x00f0ff : COL_MAGENTA));
    sideNeon.position.set(side * (DECK_WIDTH / 2 + 0.005), DECK_HEIGHT / 2 + 0.002, 0);
    group.add(sideNeon);
    neons.push(sideNeon);
  }

  // Vertical stand strips
  const vertGeo = new THREE.BoxGeometry(0.01, FACADE_HEIGHT + 0.02, 0.01);
  for (const side of [-1, 1]) {
    const vertNeon = new THREE.Mesh(vertGeo.clone(), makeNeon(side === -1 ? COL_VIOLET : COL_LIME));
    vertNeon.position.set(side * (DECK_WIDTH / 2 + 0.025), -(FACADE_HEIGHT / 2) - DECK_HEIGHT / 2, DECK_DEPTH / 2 + 0.011);
    group.add(vertNeon);
    neons.push(vertNeon);
  }

  // Bottom
  const bottomGeo = new THREE.BoxGeometry(DECK_WIDTH + 0.06, 0.01, 0.01);
  const bottomNeon = new THREE.Mesh(bottomGeo, makeNeon(0x00f0ff));
  bottomNeon.position.set(0, -DECK_HEIGHT / 2 - FACADE_HEIGHT - 0.01, DECK_DEPTH / 2 + 0.011);
  group.add(bottomNeon);
  neons.push(bottomNeon);

  // Point lights
  const ptCyan = new THREE.PointLight(0x00f0ff, 0.3, 2);
  ptCyan.position.set(0, 0, DECK_DEPTH / 2 + 0.1);
  group.add(ptCyan);

  const ptMagenta = new THREE.PointLight(COL_MAGENTA, 0.15, 1.5);
  ptMagenta.position.set(0, 0, -DECK_DEPTH / 2 - 0.1);
  group.add(ptMagenta);

  return neons;
}

// ═════════════════════════════════════════════════════════════════
// TRANSPORT BUTTONS & TEMPO FADERS
// ═════════════════════════════════════════════════════════════════

function buildTransportButtons(group: THREE.Group, centerX: number): void {
  const yTop = DECK_HEIGHT / 2 + 0.003;
  const zPos = 0.19;

  // Play
  const playGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.007, 16);
  const playMat = new THREE.MeshStandardMaterial({
    color: 0x0a1a10,
    emissive: COL_LIME,
    emissiveIntensity: 0.2,
    roughness: 0.3,
    metalness: 0.6,
  });
  const play = new THREE.Mesh(playGeo, playMat);
  play.position.set(centerX + 0.03, yTop + 0.007, zPos);
  group.add(play);

  // Cue
  const cueGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.007, 16);
  const cueMat = new THREE.MeshStandardMaterial({
    color: 0x1a1208,
    emissive: 0xff8800,
    emissiveIntensity: 0.15,
    roughness: 0.3,
    metalness: 0.6,
  });
  const cue = new THREE.Mesh(cueGeo, cueMat);
  cue.position.set(centerX - 0.03, yTop + 0.007, zPos);
  group.add(cue);
}

function buildTempoFader(group: THREE.Group, centerX: number): void {
  const yTop = DECK_HEIGHT / 2 + 0.003;

  const slotGeo = new THREE.BoxGeometry(0.012, 0.005, 0.1);
  const slot = new THREE.Mesh(slotGeo, new THREE.MeshStandardMaterial({ color: COL_FADER_SLOT, roughness: 0.6, metalness: 0.3 }));
  slot.position.set(centerX, yTop + 0.006, 0.02);
  group.add(slot);

  const capGeo = new THREE.BoxGeometry(0.018, 0.009, 0.016);
  const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.15, metalness: 0.85 }));
  cap.position.set(centerX, yTop + 0.01, 0.02);
  group.add(cap);
}
