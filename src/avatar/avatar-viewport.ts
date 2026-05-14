/**
 * Lit web component wrapping the Three.js scene for the DJ avatar.
 * Scene init, camera, lighting, and render loop follow FHAE patterns.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
import { loadAvatar } from './avatar-loader';
import { setupLighting, pulseRimLight } from './lighting-manager';
import { AnimationController } from './animation-controller';
import { createParticleSystem } from './particle-system';
import { createDJBooth, type DJBoothRefs, type AdContent } from './dj-booth';
import { createBackBillboard, type BackBillboardRefs } from './back-billboard';
import type { VRM } from '@pixiv/three-vrm';

@customElement('avatar-viewport')
export class AvatarViewport extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      overflow: hidden;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  @property({ type: Number })
  bpm: number = 128;

  @property({ type: Boolean, attribute: 'is-djing' })
  isDjing: boolean = false;

  @property({ type: String })
  genre: string = '';

  private _sessionPollTimer: number | null = null;
  private _currentSessionGenre: string = '';

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private animationController = new AnimationController();
  private particleSystem: { update: (d: number) => void } | null = null;
  private vrm: VRM | null = null;
  private djBooth: DJBoothRefs | null = null;
  private backBillboard: BackBillboardRefs | null = null;
  private rafId: number = 0;
  private resizeObserver: ResizeObserver | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private floorRing: THREE.Mesh | null = null;
  private _ttsPollTimer: number | null = null;
  private _ttsSpeaking = false;
  private _shoutoutEventSource: EventSource | null = null;
  private _shoutoutPanelToggle = false;
  private _adEventSource: EventSource | null = null;
  // Paid ad currently live per slot (null = idle) — restored after shoutout clears
  private _slotAd: Record<1 | 2 | 3, AdContent | null> = { 1: null, 2: null, 3: null };

  override render() {
    return html`<canvas></canvas>`;
  }

  // ── Public Ad Banner API (for AI agent / external systems) ────

  /** Display a single ad on the booth front panel */
  showAd(ad: AdContent): void {
    this.djBooth?.adBanner.showAd(ad);
  }

  /** Queue multiple ads for automatic rotation */
  queueAds(ads: AdContent[]): void {
    this.djBooth?.adBanner.queueAds(ads);
  }

  /** Clear all ads and return to idle state */
  clearAds(): void {
    this.djBooth?.adBanner.clearAds();
  }

  override updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('isDjing')) {
      this.animationController.setDJMode(this.isDjing);
    }
    if (changedProps.has('genre')) {
      this.animationController.setGenreBias(this.genre || null);
    }
  }

  override firstUpdated(): void {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.initScene();
    this.setupResizeObserver();
    this.loadModel();
    this.startRenderLoop();
    this._startTtsPoll();
    this._startSessionPoll();
    this._startShoutoutStream();
    this._startAdStream();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.renderer && this.rafId === 0) {
      this.startRenderLoop();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this._stopTtsPoll();
    this._stopSessionPoll();
    this._stopShoutoutStream();
    this._stopAdStream();
  }

  /**
   * Scene initialization — matches FHAE avatar-viewport initScene() pattern.
   * Renderer, scene, camera, lighting all set up identically.
   */
  private initScene(): void {
    const width = this.clientWidth || 800;
    const height = this.clientHeight || 600;

    // Renderer setup (FHAE exact pattern)
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas!,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Scene (FHAE exact: background 0x080c18, fog 0.15)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080c18);
    this.scene.fog = new THREE.FogExp2(0x080c18, 0.15);

    // Camera — raised to waist height, framing avatar behind DJ decks
    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
    this.camera.position.set(0, 1.25, 2.8);
    this.camera.lookAt(0, 1.0, 0);

    // Lighting (FHAE pattern: Key + Fill + Rim + Ambient)
    setupLighting(this.scene);

    // Avatar platform (FHAE hex-grid stage)
    this.buildPlatform();

    // 3D DJ decks in front of the avatar
    this.djBooth = createDJBooth(this.scene);

    // Curved back billboard wall behind the avatar
    try {
      this.backBillboard = createBackBillboard(this.scene);
    } catch (err) {
      console.error('[avatar-viewport] createBackBillboard failed:', err);
    }

    // Particles
    this.particleSystem = createParticleSystem(this.scene);
  }

  /**
   * FHAE avatar platform — hex floor disc + glow ring + inner accent ring.
   */
  private buildPlatform(): void {
    // Main hex floor disc
    const floorGeo = new THREE.CylinderGeometry(2.2, 2.3, 0.06, 6);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0e1a,
      roughness: 0.3,
      metalness: 0.7,
      emissive: 0x040810,
      emissiveIntensity: 0.5,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.03;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.scene.add(floor);

    // Hex grid overlay (procedural canvas texture)
    const hexCanvas = document.createElement('canvas');
    hexCanvas.width = 512;
    hexCanvas.height = 512;
    const ctx = hexCanvas.getContext('2d')!;
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
    ctx.lineWidth = 1;
    const hexSize = 24;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        const x = col * hexSize * 1.5 + (row % 2) * hexSize * 0.75;
        const y = row * hexSize * 0.866;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 6;
          const px = x + hexSize * 0.4 * Math.cos(angle);
          const py = y + hexSize * 0.4 * Math.sin(angle);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    const hexTex = new THREE.CanvasTexture(hexCanvas);
    const hexOverlayGeo = new THREE.CircleGeometry(2.2, 6);
    const hexOverlayMat = new THREE.MeshBasicMaterial({
      map: hexTex,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const hexOverlay = new THREE.Mesh(hexOverlayGeo, hexOverlayMat);
    hexOverlay.rotation.x = -Math.PI / 2;
    hexOverlay.position.y = 0.001;
    hexOverlay.name = 'floor-hex';
    this.scene.add(hexOverlay);

    // Outer glow ring (pulsing in render loop)
    const ringGeo = new THREE.RingGeometry(2.15, 2.35, 6);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.floorRing = new THREE.Mesh(ringGeo, ringMat);
    this.floorRing.rotation.x = -Math.PI / 2;
    this.floorRing.position.y = 0.002;
    this.floorRing.name = 'floor-ring';
    this.scene.add(this.floorRing);

    // Inner accent ring
    const innerRingGeo = new THREE.RingGeometry(1.0, 1.05, 64);
    const innerRingMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.003;
    innerRing.name = 'floor-inner-ring';
    this.scene.add(innerRing);
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSize();
    });
    this.resizeObserver.observe(this);
  }

  private updateSize(): void {
    const width = this.clientWidth;
    const height = this.clientHeight;
    if (!width || !height || !this.renderer || !this.camera) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private async loadModel(): Promise<void> {
    try {
      this.vrm = await loadAvatar(this.scene);
      this.animationController.setVrm(this.vrm);
      console.log('[avatar] VRM model loaded successfully');

      // Log model info for diagnostics
      const box = new THREE.Box3().setFromObject(this.vrm.scene);
      const size = box.getSize(new THREE.Vector3());
      console.log(`[avatar] Model bounds: y=${box.min.y.toFixed(2)}→${box.max.y.toFixed(2)}, size=${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`);

    } catch (err) {
      console.warn('[avatar-viewport] Could not load VRM model:', err);
    }
  }

  private startRenderLoop(): void {
    this.clock.start();
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      this.tick(delta);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /**
   * Render loop — follows FHAE order:
   * 1. Animation controller (all bone manipulation + BPM sync)
   * 2. vrm.update(delta) — spring bones, expression blending
   * 3. Particles + lighting
   * 4. Render
   */
  private tick(delta: number): void {
    const elapsed = this.clock.elapsedTime;

    if (this.vrm) {
      // 1. Animation controller handles all bone manipulation
      this.animationController.update(delta, this.bpm);

      // 2. VRM update LAST — spring bones, materials, lookAt
      this.vrm.update(delta);
    }

    // DJ booth jog wheel spinning
    this.djBooth?.update(delta, this.bpm);

    // Back billboard ad panel transitions
    this.backBillboard?.update(delta);

    // Particles
    this.particleSystem?.update(delta);

    // Beat-reactive rim light pulse + floor ring glow
    const bpmSync = this.animationController.getBpmSync();
    const beatPhase = bpmSync.getBeatPhase(elapsed);
    if (bpmSync.isOnBeat(elapsed, 0.08)) {
      pulseRimLight(2.0);
    } else {
      pulseRimLight(0.5 + Math.max(0, (1 - beatPhase * 3)) * 0.6);
    }

    // Floor ring pulse synced to beat
    if (this.floorRing) {
      const ringMat = this.floorRing.material as THREE.MeshBasicMaterial;
      ringMat.opacity = 0.15 + Math.max(0, (1 - beatPhase * 4)) * 0.25;
    }

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  // ── TTS lip-sync polling ────────────────────────────────────────────────────

  private _startTtsPoll(): void {
    const poll = async () => {
      try {
        const res = await fetch('/api/tts/state');
        if (!res.ok) return;
        const { isSpeaking, text, durationMs } = await res.json() as {
          isSpeaking: boolean; text: string | null; durationMs: number;
        };
        if (isSpeaking && !this._ttsSpeaking) {
          this._ttsSpeaking = true;
          if (text) this.animationController.speakWithEmotion(text, 'happy', 0.35, durationMs || undefined);
        } else if (!isSpeaking && this._ttsSpeaking) {
          this._ttsSpeaking = false;
          this.animationController.stopSpeaking();
        }
      } catch { /* network error — retry next tick */ }
    };
    void poll();
    this._ttsPollTimer = window.setInterval(poll, 500);
  }

  private _stopTtsPoll(): void {
    if (this._ttsPollTimer !== null) {
      clearInterval(this._ttsPollTimer);
      this._ttsPollTimer = null;
    }
  }

  // ── Session genre polling (for animation bias) ───────────────────────────────

  private _startSessionPoll(): void {
    const poll = async () => {
      try {
        const res = await fetch('/api/session/state');
        if (!res.ok) return;
        const data = await res.json() as { state?: { genre?: string | null } };
        const g = data.state?.genre ?? '';
        if (g !== this._currentSessionGenre) {
          this._currentSessionGenre = g;
          this.genre = g;
        }
      } catch { /* network error — retry next tick */ }
    };
    void poll();
    this._sessionPollTimer = window.setInterval(poll, 30_000);
  }

  private _stopSessionPoll(): void {
    if (this._sessionPollTimer !== null) {
      clearInterval(this._sessionPollTimer);
      this._sessionPollTimer = null;
    }
  }

  // ── Shoutout SSE (ad banner display) ─────────────────────────────────────────

  private _startShoutoutStream(): void {
    const es = new EventSource('/api/shoutouts/stream');
    this._shoutoutEventSource = es;

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as {
          type: 'shoutout' | 'idle';
          shoutout?: {
            name: string;
            message?: string;
            amount?: string;
            imageUrl?: string;
            displaySecs: number;
          };
        };

        if (data.type === 'shoutout' && data.shoutout) {
          const s = data.shoutout;
          const headline = s.amount
            ? `${s.name} — ${s.amount}`
            : s.name;
          const body = s.message ?? '❤️ Thanks for the support!';
          const adContent: AdContent = {
            headline,
            body,
            imageUrl: s.imageUrl,
            duration: s.displaySecs,
            accentColor: '#ff00aa',
          };

          // Front panel (DJ booth facade)
          this.djBooth?.adBanner.showAd(adContent);

          // Back billboard — alternate left/right panels per shoutout
          this._shoutoutPanelToggle = !this._shoutoutPanelToggle;
          if (this._shoutoutPanelToggle) {
            this.backBillboard?.leftPanel.showAd(adContent);
          } else {
            this.backBillboard?.rightPanel.showAd(adContent);
          }

          // Acknowledge after displaySecs so server moves to next
          setTimeout(() => {
            fetch('/api/shoutouts/ack', { method: 'POST' }).catch(() => {});
          }, s.displaySecs * 1000);

        } else if (data.type === 'idle') {
          // Restore paid ads if active, otherwise show idle
          if (this._slotAd[1]) this.djBooth?.adBanner.showAd(this._slotAd[1]!);
          else this.djBooth?.adBanner.clearAds();

          if (this._slotAd[2]) this.backBillboard?.leftPanel.showAd(this._slotAd[2]!);
          else this.backBillboard?.leftPanel.clearAds();

          if (this._slotAd[3]) this.backBillboard?.rightPanel.showAd(this._slotAd[3]!);
          else this.backBillboard?.rightPanel.clearAds();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      // SSE will auto-reconnect — no action needed
    };
  }

  private _stopShoutoutStream(): void {
    this._shoutoutEventSource?.close();
    this._shoutoutEventSource = null;
  }

  // ── Paid Ad SSE (per-slot placement) ──────────────────────────────────────────

  private _startAdStream(): void {
    const es = new EventSource('/api/ads/stream');
    this._adEventSource = es;

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as {
          type: 'ad_show' | 'ad_idle';
          slot?: 1 | 2 | 3;
          booking?: {
            headline: string;
            body?: string;
            imageUrl?: string;
            displaySecs: number;
            bgColor?: string;
            accentColor?: string;
          };
        };

        const slot = data.slot;
        if (!slot) return;

        if (data.type === 'ad_show' && data.booking) {
          const b = data.booking;
          const adContent: AdContent = {
            headline:    b.headline,
            body:        b.body,
            imageUrl:    b.imageUrl,
            duration:    b.displaySecs,
            bgColor:     b.bgColor,
            accentColor: b.accentColor ?? '#00d4ff',
          };
          this._slotAd[slot] = adContent;
          if (slot === 1) this.djBooth?.adBanner.showAd(adContent);
          else if (slot === 2) this.backBillboard?.leftPanel.showAd(adContent);
          else if (slot === 3) this.backBillboard?.rightPanel.showAd(adContent);

        } else if (data.type === 'ad_idle') {
          this._slotAd[slot] = null;
          if (slot === 1) this.djBooth?.adBanner.clearAds();
          else if (slot === 2) this.backBillboard?.leftPanel.clearAds();
          else if (slot === 3) this.backBillboard?.rightPanel.clearAds();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      // SSE auto-reconnects
    };
  }

  private _stopAdStream(): void {
    this._adEventSource?.close();
    this._adEventSource = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'avatar-viewport': AvatarViewport;
  }
}
