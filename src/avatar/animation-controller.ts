/**
 * Animation controller for the DJ avatar.
 * Full FHAE animation system: FBX loading, idle cycling, blink, lip sync,
 * expression auto-decay, emotion driver, finger curl, rest pose.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { retargetAnimation } from 'vrm-mixamo-retarget';
import type { VRM } from '@pixiv/three-vrm';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import { BpmSync } from './bpm-sync';
import { EmotionDriver } from './emotion-driver';
import {
  ANIMATION_CATALOG,
  type AnimationInfo,
} from './animation-retarget';

// ─── Lip-sync constants (FHAE exact) ───
const VISEME_NAMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
const VOWEL_VISEME: Record<string, string> = {
  a: 'aa', e: 'ee', i: 'ih', o: 'oh', u: 'ou',
};
const LIP_CONSONANT_VISEME: Record<string, string> = {
  b: 'aa', m: 'aa', p: 'aa',
  f: 'ih', v: 'ih',
  w: 'ou',
};
const PAUSE_CHARS = new Set([' ', '.', ',', '!', '?', ';', ':', '-', '\n']);

export class AnimationController {
  private vrm: VRM | null = null;
  private bpmSync: BpmSync;
  private energy: number = 0.5;

  // Animation mixer
  private mixer: THREE.AnimationMixer | null = null;
  private animClips = new Map<string, AnimationInfo>();
  private activeAction: THREE.AnimationAction | null = null;
  private useExternalAnimation = false;

  // Idle cycle (FHAE)
  private idleCycleNames: string[] = [];
  private idleCycleIndex = 0;
  private idleCycleTimer = 0;
  private idleCycleDuration = 12;
  private isIdleCycling = true;

  // Blink (FHAE)
  private blinkTimer = 0;
  private nextBlinkAt = 3;
  private isBlinking = false;
  private blinkProgress = 0;

  // Lip-sync (FHAE)
  private isSpeaking = false;
  private visemeQueue: Array<{ viseme: string; duration: number }> = [];
  private visemeIndex = 0;
  private visemeTimer = 0;
  private visemeWeights: Record<string, number> = { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 };

  // Expression auto-decay (FHAE)
  private activeExpressions = new Map<string, { value: number; decayRate: number; holdUntil: number }>();
  private expressionClock = 0;

  // Emotion driver (FHAE)
  private emotionDriver = new EmotionDriver();
  private lookAtTarget = new THREE.Object3D();
  private defaultLookAtPos = new THREE.Vector3(0, 1.4, 2);

  // DJ mode state
  private _isDjing = false;
  private _djAnimNames: string[] = [];
  private _djCycleIndex = 0;
  private _djCycleTimer = 0;
  private readonly DJ_CYCLE_DURATION = 16; // seconds per dance before switching

  // Procedural idle time
  private elapsedTime = 0;

  // Cached finger bones
  private fingerBones?: Array<{ bone: THREE.Object3D; axis: 'x' | 'z'; curl: number }>;

  constructor(bpm: number = 128) {
    this.bpmSync = new BpmSync(bpm);
  }

  setVrm(vrm: VRM): void {
    this.vrm = vrm;
    this.fingerBones = undefined;

    // Create mixer
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer.addEventListener('finished', () => {
      if (this.isIdleCycling) {
        this.advanceIdleCycle();
      } else {
        this.startIdleCycle();
      }
    });

    // Apply rest pose once
    this.applyRestPose();

    // Load animations
    this.loadAllAnimations();
  }

  setEnergy(level: number): void {
    this.energy = Math.max(0, Math.min(1, level));
  }

  /**
   * Set DJ mode — when true, plays the DJ animation (hip-hop dancing).
   * When false, returns to idle cycle. Use this when music starts/stops.
   */
  setDJMode(active: boolean): void {
    if (active === this._isDjing) return;
    this._isDjing = active;

    if (active && this._djAnimNames.length > 0) {
      this.isIdleCycling = false;
      this._djCycleTimer = 0;
      const name = this._djAnimNames[this._djCycleIndex];
      this.playAnimationInternal(name, 0.6);
      console.log(`[avatar] DJ mode ON — playing ${name}`);
    } else if (!active) {
      console.log('[avatar] DJ mode OFF — returning to idle');
      this.startIdleCycle();
    }
  }

  /** Whether the avatar is in DJ mode. */
  get isDjing(): boolean {
    return this._isDjing;
  }

  /**
   * Bias the DJ animation cycle toward genre-appropriate movements.
   * Reorders _djAnimNames so preferred animations play first.
   * Safe to call at any time — takes effect on the next cycle switch.
   */
  setGenreBias(genre: string | null): void {
    if (this._djAnimNames.length === 0) return;

    const GENRE_PREFS: Record<string, string[]> = {
      'lo-fi':          ['arms-hiphop'],
      'reggae':         ['arms-hiphop'],
      'afrobeats':      ['arms-hiphop'],
      'afro-dancehall': ['twerk'],
      'amapiano':       ['arms-hiphop'],
      'hip-hop':        ['hip-hop-dancing', 'hip-hop-dancing-1', 'hip-hop-dancing-2', 'arms-hiphop'],
      'trap-dancehall': ['twerk', 'hip-hop-dancing-2'],
      'grime':          ['breakdance-ready', 'hip-hop-dancing-2'],
      'drill':          ['breakdance-ready', 'hip-hop-dancing-2', 'hip-hop-dancing'],
    };

    const prefs = genre ? (GENRE_PREFS[genre.toLowerCase()] ?? []) : [];
    const preferred = prefs.filter(p => this._djAnimNames.includes(p));
    const others = this._djAnimNames.filter(n => !preferred.includes(n));
    this._djAnimNames = [...preferred, ...others];
    this._djCycleIndex = 0;

    console.log(`[avatar] Genre bias → ${genre ?? 'none'}: [${this._djAnimNames.join(', ')}]`);
  }

  /**
   * Main update — called every frame.
   * Follows FHAE render loop order exactly.
   * NOTE: Does NOT call vrm.update() — the viewport handles that after this.
   */
  update(delta: number, bpm: number): void {
    if (!this.vrm) return;
    this.bpmSync.setBpm(bpm);
    this.elapsedTime += delta;

    // 1. Procedural idle (only when no FBX animation driving bones)
    this.updateIdleAnimation(delta);

    // 2. Eye blink
    this.updateBlink(delta);

    // 3. Lip-sync
    this.updateLipSync(delta);

    // 4. Expression auto-decay
    this.updateExpressions(delta);

    // 5. Emotion driver (compound expressions, gaze, head pose, blink)
    this.emotionDriver.update(
      delta,
      this.vrm.expressionManager as any,
      this.vrm.humanoid as any,
      this.lookAtTarget,
      this.defaultLookAtPos,
    );

    // 6. AnimationMixer (FBX bone rotations)
    if (this.mixer) {
      this.mixer.update(delta);
      if (this._isDjing) {
        this.updateDjCycle(delta);
      } else {
        this.updateIdleCycle(delta);
      }
    }

    // 7. Finger curl BEFORE vrm.update()
    this.applyFingerCurl();
  }

  // ════════════════════════════════════════════════════════════
  //  REST POSE (FHAE exact — break T-pose into natural standing)
  // ════════════════════════════════════════════════════════════

  private applyRestPose(): void {
    if (!this.vrm) return;
    const h = this.vrm.humanoid;

    // Arms hanging naturally at sides
    const leftUpperArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const rightUpperArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    if (leftUpperArm) {
      leftUpperArm.rotation.z = 1.10;
      leftUpperArm.rotation.x = 0.12;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.z = -1.10;
      rightUpperArm.rotation.x = 0.12;
    }

    // Elbow bend
    const leftLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rightLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    if (leftLowerArm) {
      leftLowerArm.rotation.y = -0.22;
      leftLowerArm.rotation.z = 0.06;
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.y = 0.22;
      rightLowerArm.rotation.z = -0.06;
    }

    // Wrist rotation
    const leftHand = h.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
    const rightHand = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);
    if (leftHand) {
      leftHand.rotation.z = 0.15;
      leftHand.rotation.x = -0.08;
    }
    if (rightHand) {
      rightHand.rotation.z = -0.15;
      rightHand.rotation.x = -0.08;
    }

    // Hips — contrapposto
    const hips = h.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    if (hips) {
      hips.rotation.z = 0.025;
      hips.position.x = 0.02;
    }

    // Left knee slightly bent
    const leftUpperLeg = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg);
    const leftLowerLeg = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerLeg);
    if (leftUpperLeg) leftUpperLeg.rotation.x = -0.05;
    if (leftLowerLeg) leftLowerLeg.rotation.x = 0.08;

    // Head tilt
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);
    if (head) {
      head.rotation.z = 0.03;
      head.rotation.x = -0.02;
    }

    // Spine S-curve
    const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    if (spine) spine.rotation.x = -0.02;
  }

  // ════════════════════════════════════════════════════════════
  //  PROCEDURAL IDLE (FHAE — only when no FBX animation active)
  // ════════════════════════════════════════════════════════════

  private updateIdleAnimation(_delta: number): void {
    if (!this.vrm) return;
    if (this.useExternalAnimation) return;
    const h = this.vrm.humanoid;
    const t = this.elapsedTime;

    // Breathing: Spine + Chest
    const spine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
    const chest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
    if (spine) {
      spine.rotation.x = -0.02 + Math.sin(t * 0.8) * 0.01;
      spine.rotation.z = Math.sin(t * 0.3) * 0.006;
    }
    if (chest) {
      chest.rotation.x = Math.sin(t * 1.0) * 0.012;
    }

    // Head: gentle looking around
    const head = h.getNormalizedBoneNode(VRMHumanBoneName.Head);
    if (head) {
      head.rotation.x = -0.02 + Math.sin(t * 0.5) * 0.018;
      head.rotation.z = 0.03 + Math.sin(t * 0.35 + 1.2) * 0.015;
      head.rotation.y = Math.sin(t * 0.25 + 0.7) * 0.025;
    }

    // Arms: hanging with gentle sway
    const leftUpperArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
    const rightUpperArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
    const leftLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
    const rightLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
    if (leftUpperArm) {
      leftUpperArm.rotation.z = 1.10 + Math.sin(t * 0.4) * 0.02;
      leftUpperArm.rotation.x = 0.12 + Math.sin(t * 0.6) * 0.03;
      leftUpperArm.rotation.y = Math.sin(t * 0.3) * 0.015;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.z = -1.10 + Math.sin(t * 0.4 + 0.8) * 0.02;
      rightUpperArm.rotation.x = 0.12 + Math.sin(t * 0.6 + 1.5) * 0.03;
      rightUpperArm.rotation.y = Math.sin(t * 0.3 + 1.0) * 0.015;
    }
    if (leftLowerArm) {
      leftLowerArm.rotation.y = -0.22 + Math.sin(t * 0.5 + 0.3) * 0.025;
      leftLowerArm.rotation.z = 0.06;
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.y = 0.22 + Math.sin(t * 0.5 + 1.0) * 0.025;
      rightLowerArm.rotation.z = -0.06;
    }

    // Hands: wrist rotation
    const leftHand = h.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
    const rightHand = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);
    if (leftHand) {
      leftHand.rotation.z = 0.15 + Math.sin(t * 0.35) * 0.04;
      leftHand.rotation.x = -0.08;
    }
    if (rightHand) {
      rightHand.rotation.z = -0.15 + Math.sin(t * 0.35 + 0.7) * 0.04;
      rightHand.rotation.x = -0.08;
    }

    // Shoulders: breathing rise/fall
    const leftShoulder = h.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
    const rightShoulder = h.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);
    if (leftShoulder) leftShoulder.rotation.z = Math.sin(t * 1.0) * 0.008;
    if (rightShoulder) rightShoulder.rotation.z = Math.sin(t * 1.0 + Math.PI) * 0.008;

    // Weight shift: hips — FHAE does NOT touch position.y
    const hips = h.getNormalizedBoneNode(VRMHumanBoneName.Hips);
    if (hips) {
      hips.rotation.z = 0.03 + Math.sin(t * 0.2) * 0.015;
      hips.rotation.y = Math.sin(t * 0.15) * 0.01;
      hips.position.x = 0.02 + Math.sin(t * 0.2) * 0.01;
    }

    // Upper chest: slight lean
    const upperChest = h.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
    if (upperChest) {
      upperChest.rotation.x = Math.sin(t * 0.9 + 0.5) * 0.008;
      upperChest.rotation.z = Math.sin(t * 0.25) * 0.005;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  EYE BLINK (FHAE exact)
  // ════════════════════════════════════════════════════════════

  private updateBlink(delta: number): void {
    if (!this.vrm?.expressionManager) return;

    this.blinkTimer += delta;

    if (!this.isBlinking && this.blinkTimer >= this.nextBlinkAt) {
      this.isBlinking = true;
      this.blinkProgress = 0;
    }

    if (this.isBlinking) {
      this.blinkProgress += delta * 8;

      let blinkValue: number;
      if (this.blinkProgress < 0.5) {
        blinkValue = this.blinkProgress * 2;
      } else if (this.blinkProgress < 1.0) {
        blinkValue = 1 - (this.blinkProgress - 0.5) * 2;
      } else {
        blinkValue = 0;
        this.isBlinking = false;
        this.blinkTimer = 0;
        this.nextBlinkAt = 2 + Math.random() * 4;
      }

      this.vrm.expressionManager.setValue('blink', blinkValue);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  LIP-SYNC (FHAE exact — vowel-driven viseme system)
  // ════════════════════════════════════════════════════════════

  speak(text: string, durationMs?: number): void {
    if (!this.vrm?.expressionManager) return;

    this.isSpeaking = true;
    this.visemeQueue = this.buildVisemeQueue(text, durationMs);
    this.visemeIndex = 0;
    this.visemeTimer = 0;

    this.setExpressionPersistent('happy', 0.3);
  }

  speakWithEmotion(text: string, emotion = 'happy', intensity = 0.5, durationMs?: number): void {
    if (!this.vrm?.expressionManager) return;

    this.setExpressionPersistent(emotion, Math.max(0, Math.min(1, intensity)));

    this.isSpeaking = true;
    this.visemeQueue = this.buildVisemeQueue(text, durationMs);
    this.visemeIndex = 0;
    this.visemeTimer = 0;
  }

  speakWithDrivenEmotion(text: string, emotion: string, intensity = 0.7, durationMs?: number): void {
    if (!this.vrm?.expressionManager) return;
    this.speak(text, durationMs);
    this.emotionDriver.play(emotion, durationMs ?? text.length * 80, intensity);
  }

  stopSpeaking(): void {
    this.isSpeaking = false;
    this.visemeQueue = [];
    this.visemeIndex = 0;
    this.visemeTimer = 0;

    this.emotionDriver.stop();

    // Return to DJ mode if music is playing, otherwise idle
    if (this._isDjing && this._djAnimNames.length > 0) {
      this.isIdleCycling = false;
      this.playAnimationInternal(this._djAnimNames[this._djCycleIndex], 0.6);
    } else if (this.idleCycleNames.length > 0) {
      this.startIdleCycle();
    }

    for (const v of VISEME_NAMES) {
      this.visemeWeights[v] = 0;
    }
    if (this.vrm?.expressionManager) {
      for (const v of VISEME_NAMES) {
        this.vrm.expressionManager.setValue(v, 0);
      }
      // Schedule active expressions for decay
      const emotionNames = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
      for (const eName of emotionNames) {
        const val = this.vrm.expressionManager.getValue(eName);
        if (val && val > 0) {
          this.activeExpressions.set(eName, {
            value: val,
            decayRate: val / 0.6,
            holdUntil: this.expressionClock,
          });
        }
      }
    }
  }

  private buildVisemeQueue(text: string, totalDurationMs?: number): Array<{ viseme: string; duration: number }> {
    const raw: Array<{ viseme: string; baseDuration: number }> = [];
    const chars = text.toLowerCase();

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (PAUSE_CHARS.has(ch)) {
        raw.push({ viseme: '', baseDuration: ch === ' ' ? 0.08 : 0.20 });
      } else if (VOWEL_VISEME[ch]) {
        raw.push({ viseme: VOWEL_VISEME[ch], baseDuration: 0.18 });
      } else if (LIP_CONSONANT_VISEME[ch]) {
        raw.push({ viseme: LIP_CONSONANT_VISEME[ch], baseDuration: 0.07 });
      } else {
        raw.push({ viseme: '', baseDuration: 0.04 });
      }
    }

    // Merge adjacent identical visemes
    const merged: Array<{ viseme: string; baseDuration: number }> = [];
    for (const entry of raw) {
      const last = merged[merged.length - 1];
      if (last && last.viseme === entry.viseme) {
        last.baseDuration += entry.baseDuration;
      } else {
        merged.push({ ...entry });
      }
    }

    // Scale to fit total duration
    if (totalDurationMs) {
      const totalBase = merged.reduce((sum, e) => sum + e.baseDuration, 0);
      const scale = totalBase > 0 ? (totalDurationMs / 1000) / totalBase : 1;
      for (const e of merged) e.baseDuration *= scale;
    }

    merged.push({ viseme: '', baseDuration: 0.2 });
    return merged.map(e => ({ viseme: e.viseme, duration: e.baseDuration }));
  }

  private updateLipSync(delta: number): void {
    if (!this.vrm?.expressionManager) return;

    const LERP_SPEED = 8;

    if (!this.isSpeaking || this.visemeIndex >= this.visemeQueue.length) {
      let anyActive = false;
      for (const v of VISEME_NAMES) {
        if (this.visemeWeights[v] > 0.001) {
          this.visemeWeights[v] = Math.max(0, this.visemeWeights[v] - delta * LERP_SPEED);
          this.vrm.expressionManager.setValue(v, this.visemeWeights[v]);
          anyActive = true;
        }
      }
      if (this.visemeIndex >= this.visemeQueue.length && this.isSpeaking && !anyActive) {
        this.stopSpeaking();
      }
      return;
    }

    this.visemeTimer += delta;
    while (
      this.visemeIndex < this.visemeQueue.length &&
      this.visemeTimer >= this.visemeQueue[this.visemeIndex].duration
    ) {
      this.visemeTimer -= this.visemeQueue[this.visemeIndex].duration;
      this.visemeIndex++;
    }

    const current = this.visemeIndex < this.visemeQueue.length
      ? this.visemeQueue[this.visemeIndex]
      : null;
    const targetViseme = current?.viseme || '';

    let envelope = 0.65;
    if (current && current.duration > 0) {
      const t = this.visemeTimer / current.duration;
      envelope = Math.sin(t * Math.PI) * 0.3 + 0.45;
    }

    for (const v of VISEME_NAMES) {
      const target = v === targetViseme ? envelope : 0;
      const w = this.visemeWeights[v];
      this.visemeWeights[v] = w + (target - w) * Math.min(1, delta * LERP_SPEED);
      this.vrm.expressionManager.setValue(v, this.visemeWeights[v]);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  EXPRESSIONS (FHAE — auto-decay)
  // ════════════════════════════════════════════════════════════

  setExpression(name: string, value: number, holdMs = 1500, decayMs = 800): void {
    const v = Math.max(0, Math.min(1, value));
    this.vrm?.expressionManager?.setValue(name, v);
    if (v > 0) {
      this.activeExpressions.set(name, {
        value: v,
        decayRate: v / (decayMs / 1000),
        holdUntil: this.expressionClock + holdMs / 1000,
      });
    } else {
      this.activeExpressions.delete(name);
    }
  }

  setExpressionPersistent(name: string, value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.vrm?.expressionManager?.setValue(name, v);
    this.activeExpressions.delete(name);
  }

  clearExpressions(): void {
    if (!this.vrm?.expressionManager) return;
    for (const name of this.activeExpressions.keys()) {
      this.vrm.expressionManager.setValue(name, 0);
    }
    this.activeExpressions.clear();
    this.emotionDriver.stop();
  }

  private updateExpressions(delta: number): void {
    if (!this.vrm?.expressionManager) return;
    this.expressionClock += delta;

    for (const [name, state] of this.activeExpressions) {
      if (this.expressionClock < state.holdUntil) continue;
      state.value = Math.max(0, state.value - state.decayRate * delta);
      this.vrm.expressionManager.setValue(name, state.value);
      if (state.value <= 0) {
        this.activeExpressions.delete(name);
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  EMOTION DRIVER (public API)
  // ════════════════════════════════════════════════════════════

  driveEmotion(name: string, durationMs = 0, intensity = 1.0): void {
    this.emotionDriver.play(name, durationMs, intensity);
  }

  stopEmotion(): void {
    this.emotionDriver.stop();
  }

  get emotionActive(): boolean {
    return this.emotionDriver.isActive;
  }

  // ════════════════════════════════════════════════════════════
  //  FBX LOADING + IDLE CYCLING (FHAE exact)
  // ════════════════════════════════════════════════════════════

  private async loadAllAnimations(): Promise<void> {
    if (!this.vrm) return;
    const fbxLoader = new FBXLoader();

    // Load sequentially like FHAE (retargetAnimation needs stable VRM state)
    let loaded = 0;
    for (const entry of ANIMATION_CATALOG) {
      try {
        const fbx = await fbxLoader.loadAsync(entry.url);
        if (fbx.animations.length === 0) {
          console.warn(`[avatar] No animations in "${entry.name}"`);
          continue;
        }

        // Use vrm-mixamo-retarget — the exact same call as FHAE
        const clipName = fbx.animations[0]?.name || 'mixamo.com';
        const clip = retargetAnimation(fbx, this.vrm as any, { animationClipName: clipName });
        if (!clip) continue;
        clip.name = entry.name;

        this.animClips.set(entry.name, {
          name: entry.name,
          category: entry.category,
          clip,
          loop: entry.loop !== false,
        });
        loaded++;
      } catch (err) {
        console.warn(`[avatar] Failed to load ${entry.name}:`, err);
      }
    }

    console.log(`[avatar] Loaded ${loaded}/${ANIMATION_CATALOG.length} animations`);

    this.idleCycleNames = ANIMATION_CATALOG
      .filter(e => e.category === 'idle' && this.animClips.has(e.name))
      .map(e => e.name);

    // Collect all DJ dance animations for cycling
    this._djAnimNames = ANIMATION_CATALOG
      .filter(e => e.category === 'djing' && this.animClips.has(e.name))
      .map(e => e.name);
    // Shuffle so the cycle order is different each session
    for (let i = this._djAnimNames.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._djAnimNames[i], this._djAnimNames[j]] = [this._djAnimNames[j], this._djAnimNames[i]];
    }
    this._djCycleIndex = 0;
    console.log(`[avatar] DJ dance cycle (${this._djAnimNames.length}): ${this._djAnimNames.join(', ')}`);

    console.log(`[avatar] Idle cycle: ${this.idleCycleNames.join(', ')}`);

    if (this.idleCycleNames.length > 0) {
      // If already in DJ mode (music was playing before animations loaded), start DJ anim
      if (this._isDjing && this._djAnimNames.length > 0) {
        this.isIdleCycling = false;
        this.playAnimationInternal(this._djAnimNames[this._djCycleIndex], 0.6);
      } else {
        this.startIdleCycle();
      }
    }
  }

  private startIdleCycle(): void {
    if (this.idleCycleNames.length === 0) return;
    this.isIdleCycling = true;
    this.idleCycleTimer = 0;
    const name = this.idleCycleNames[this.idleCycleIndex];
    this.playAnimationInternal(name, 0.8);
  }

  private advanceIdleCycle(): void {
    if (this.idleCycleNames.length === 0) return;
    this.idleCycleIndex = (this.idleCycleIndex + 1) % this.idleCycleNames.length;
    this.idleCycleTimer = 0;
    const name = this.idleCycleNames[this.idleCycleIndex];
    console.log(`[avatar] Idle cycle -> ${name}`);
    this.playAnimationInternal(name, 0.8);
  }

  private updateIdleCycle(delta: number): void {
    if (!this.isIdleCycling || this.idleCycleNames.length <= 1) return;
    const currentInfo = this.animClips.get(this.idleCycleNames[this.idleCycleIndex]);
    if (!currentInfo) return;

    if (currentInfo.loop) {
      this.idleCycleTimer += delta;
      if (this.idleCycleTimer >= this.idleCycleDuration) {
        this.advanceIdleCycle();
      }
    }
  }

  private updateDjCycle(delta: number): void {
    if (this._djAnimNames.length <= 1) return;
    this._djCycleTimer += delta;
    if (this._djCycleTimer >= this.DJ_CYCLE_DURATION) {
      this._djCycleTimer = 0;
      this._djCycleIndex = (this._djCycleIndex + 1) % this._djAnimNames.length;
      const name = this._djAnimNames[this._djCycleIndex];
      console.log(`[avatar] DJ cycle → ${name}`);
      this.playAnimationInternal(name, 0.8);
    }
  }

  playAnimation(name: string, fadeDuration = 0.5): void {
    const info = this.animClips.get(name);
    if (!info || !this.mixer) return;
    if (info.category !== 'idle') {
      this.isIdleCycling = false;
    }
    this.playAnimationInternal(name, fadeDuration);
  }

  private playAnimationInternal(name: string, fadeDuration = 0.5): void {
    const info = this.animClips.get(name);
    if (!info || !this.mixer) return;

    const newAction = this.mixer.clipAction(info.clip);
    newAction.setLoop(info.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (!info.loop) newAction.clampWhenFinished = true;

    if (this.activeAction && this.activeAction !== newAction) {
      this.activeAction.fadeOut(fadeDuration);
      newAction.reset().fadeIn(fadeDuration).play();
    } else {
      newAction.reset().play();
    }

    this.activeAction = newAction;
    this.useExternalAnimation = true;
  }

  playIdle(): void {
    this.startIdleCycle();
  }

  // ════════════════════════════════════════════════════════════
  //  FINGER CURL (FHAE exact)
  // ════════════════════════════════════════════════════════════

  private applyFingerCurl(): void {
    if (!this.vrm) return;

    if (!this.fingerBones) {
      this.fingerBones = [];
      const h = this.vrm.humanoid;
      const fingerDefs: Array<[VRMHumanBoneName, 'x' | 'z', number]> = [
        [VRMHumanBoneName.LeftIndexProximal, 'z', 0.35],
        [VRMHumanBoneName.LeftIndexIntermediate, 'z', 0.45],
        [VRMHumanBoneName.LeftIndexDistal, 'z', 0.3],
        [VRMHumanBoneName.LeftMiddleProximal, 'z', 0.4],
        [VRMHumanBoneName.LeftMiddleIntermediate, 'z', 0.5],
        [VRMHumanBoneName.LeftMiddleDistal, 'z', 0.35],
        [VRMHumanBoneName.LeftRingProximal, 'z', 0.45],
        [VRMHumanBoneName.LeftRingIntermediate, 'z', 0.55],
        [VRMHumanBoneName.LeftRingDistal, 'z', 0.4],
        [VRMHumanBoneName.LeftLittleProximal, 'z', 0.45],
        [VRMHumanBoneName.LeftLittleIntermediate, 'z', 0.55],
        [VRMHumanBoneName.LeftLittleDistal, 'z', 0.4],
        [VRMHumanBoneName.LeftThumbMetacarpal, 'z', 0.15],
        [VRMHumanBoneName.LeftThumbProximal, 'z', 0.15],
        [VRMHumanBoneName.LeftThumbDistal, 'z', 0.15],
        [VRMHumanBoneName.RightIndexProximal, 'z', -0.35],
        [VRMHumanBoneName.RightIndexIntermediate, 'z', -0.45],
        [VRMHumanBoneName.RightIndexDistal, 'z', -0.3],
        [VRMHumanBoneName.RightMiddleProximal, 'z', -0.4],
        [VRMHumanBoneName.RightMiddleIntermediate, 'z', -0.5],
        [VRMHumanBoneName.RightMiddleDistal, 'z', -0.35],
        [VRMHumanBoneName.RightRingProximal, 'z', -0.45],
        [VRMHumanBoneName.RightRingIntermediate, 'z', -0.55],
        [VRMHumanBoneName.RightRingDistal, 'z', -0.4],
        [VRMHumanBoneName.RightLittleProximal, 'z', -0.45],
        [VRMHumanBoneName.RightLittleIntermediate, 'z', -0.55],
        [VRMHumanBoneName.RightLittleDistal, 'z', -0.4],
        [VRMHumanBoneName.RightThumbMetacarpal, 'z', -0.15],
        [VRMHumanBoneName.RightThumbProximal, 'z', -0.15],
        [VRMHumanBoneName.RightThumbDistal, 'z', -0.15],
      ];
      for (const [name, axis, curl] of fingerDefs) {
        const bone = h.getNormalizedBoneNode(name);
        if (bone) this.fingerBones.push({ bone, axis, curl });
      }
      console.log(`[avatar] Finger bones resolved: ${this.fingerBones.length}`);
    }

    for (const { bone, axis, curl } of this.fingerBones) {
      bone.rotation[axis] = curl;
    }
  }

  getBpmSync(): BpmSync {
    return this.bpmSync;
  }
}
