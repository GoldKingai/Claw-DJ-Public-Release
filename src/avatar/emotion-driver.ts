/**
 * Emotion Driver — Drives complex compound facial expressions on VRM avatars.
 * Copied from FHAE emotion-driver.ts.
 */

import * as THREE from "three";

// ─── Types ───────────────────────────────────────────────────

interface ExpressionManager {
  setValue(name: string, value: number): void;
  getValue(name: string): number | null;
}

interface VRMHumanoid {
  getNormalizedBoneNode(name: string): THREE.Object3D | null;
}

interface MicroKeyframe {
  time: number;
  blendShapes: Partial<Record<string, number>>;
  headPose?: { tiltZ?: number; nodX?: number; turnY?: number };
}

type GazeBehaviour = "hold" | "slow-drift" | "avert-return" | "flutter" | "downcast" | "up-through" | "normal";
type BlinkPattern = "slow" | "rapid" | "half" | "wink" | "normal";

export interface EmotionRecipe {
  name: string;
  blendShapes: Partial<Record<string, number>>;
  headPose?: { tiltZ?: number; nodX?: number; turnY?: number };
  gaze: GazeBehaviour;
  blink: BlinkPattern;
  micro?: MicroKeyframe[];
  transitionIn?: number;
  transitionOut?: number;
}

// ─── Emotion Library ─────────────────────────────────────────

export const EMOTION_LIBRARY: Record<string, EmotionRecipe> = {
  flirty: {
    name: "Flirty",
    blendShapes: { happy: 0.35, relaxed: 0.45 },
    headPose: { tiltZ: 0.08, nodX: 0.04 },
    gaze: "avert-return",
    blink: "slow",
    transitionIn: 0.6,
    transitionOut: 0.8,
    micro: [
      { time: 0.0, blendShapes: { happy: 0.25, relaxed: 0.3 } },
      { time: 0.3, blendShapes: { happy: 0.45, relaxed: 0.5 }, headPose: { tiltZ: 0.12 } },
      { time: 0.6, blendShapes: { happy: 0.3, relaxed: 0.55 }, headPose: { tiltZ: 0.05 } },
      { time: 1.0, blendShapes: { happy: 0.35, relaxed: 0.45 } },
    ],
  },
  affectionate: {
    name: "Affectionate",
    blendShapes: { happy: 0.55, relaxed: 0.6 },
    headPose: { tiltZ: 0.10, nodX: 0.06 },
    gaze: "hold",
    blink: "slow",
    transitionIn: 0.8,
    transitionOut: 1.0,
    micro: [
      { time: 0.0, blendShapes: { happy: 0.45, relaxed: 0.5 } },
      { time: 0.4, blendShapes: { happy: 0.65, relaxed: 0.65 } },
      { time: 0.7, blendShapes: { happy: 0.5, relaxed: 0.6 } },
      { time: 1.0, blendShapes: { happy: 0.55, relaxed: 0.6 } },
    ],
  },
  seductive: {
    name: "Seductive",
    blendShapes: { happy: 0.2, relaxed: 0.7 },
    headPose: { tiltZ: 0.12, nodX: 0.08, turnY: -0.06 },
    gaze: "up-through",
    blink: "half",
    transitionIn: 1.0,
    transitionOut: 1.2,
    micro: [
      { time: 0.0, blendShapes: { happy: 0.15, relaxed: 0.5 } },
      { time: 0.25, blendShapes: { happy: 0.25, relaxed: 0.75 } },
      { time: 0.5, blendShapes: { happy: 0.15, relaxed: 0.7 }, headPose: { tiltZ: 0.15 } },
      { time: 0.75, blendShapes: { happy: 0.3, relaxed: 0.65 }, headPose: { tiltZ: 0.08 } },
      { time: 1.0, blendShapes: { happy: 0.2, relaxed: 0.7 } },
    ],
  },
  shy: {
    name: "Shy",
    blendShapes: { happy: 0.2, sad: 0.15, relaxed: 0.3 },
    headPose: { tiltZ: 0.06, nodX: 0.10 },
    gaze: "avert-return",
    blink: "rapid",
    transitionIn: 0.5,
    transitionOut: 0.6,
    micro: [
      { time: 0.0, blendShapes: { happy: 0.1, sad: 0.2 } },
      { time: 0.3, blendShapes: { happy: 0.3, sad: 0.05 }, headPose: { nodX: 0.12 } },
      { time: 0.7, blendShapes: { happy: 0.15, sad: 0.15 }, headPose: { nodX: 0.08 } },
      { time: 1.0, blendShapes: { happy: 0.2, sad: 0.15 } },
    ],
  },
  longing: {
    name: "Longing",
    blendShapes: { sad: 0.3, relaxed: 0.5, happy: 0.15 },
    headPose: { tiltZ: 0.10, nodX: 0.05 },
    gaze: "hold",
    blink: "slow",
    transitionIn: 1.0,
    transitionOut: 1.2,
  },
  joyful: {
    name: "Joyful",
    blendShapes: { happy: 0.85, surprised: 0.15 },
    headPose: { nodX: -0.04 },
    gaze: "hold",
    blink: "normal",
    transitionIn: 0.4,
    transitionOut: 0.6,
  },
  playful: {
    name: "Playful",
    blendShapes: { happy: 0.6, surprised: 0.25 },
    headPose: { tiltZ: -0.08, turnY: 0.05 },
    gaze: "flutter",
    blink: "normal",
    transitionIn: 0.3,
    transitionOut: 0.5,
    micro: [
      { time: 0.0, blendShapes: { happy: 0.5, surprised: 0.1 } },
      { time: 0.3, blendShapes: { happy: 0.7, surprised: 0.35 }, headPose: { tiltZ: -0.12 } },
      { time: 0.6, blendShapes: { happy: 0.55, surprised: 0.15 }, headPose: { tiltZ: -0.04 } },
      { time: 1.0, blendShapes: { happy: 0.6, surprised: 0.25 } },
    ],
  },
  amused: {
    name: "Amused",
    blendShapes: { happy: 0.5, surprised: 0.1, relaxed: 0.2 },
    headPose: { tiltZ: 0.05 },
    gaze: "hold",
    blink: "normal",
    transitionIn: 0.3,
    transitionOut: 0.5,
  },
  excited: {
    name: "Excited",
    blendShapes: { happy: 0.75, surprised: 0.45 },
    headPose: { nodX: -0.06 },
    gaze: "flutter",
    blink: "rapid",
    transitionIn: 0.2,
    transitionOut: 0.4,
  },
  concerned: {
    name: "Concerned",
    blendShapes: { sad: 0.35, relaxed: 0.25 },
    headPose: { tiltZ: 0.08, nodX: 0.04 },
    gaze: "hold",
    blink: "normal",
    transitionIn: 0.6,
    transitionOut: 0.8,
  },
  empathetic: {
    name: "Empathetic",
    blendShapes: { sad: 0.25, happy: 0.15, relaxed: 0.4 },
    headPose: { tiltZ: 0.06, nodX: 0.06 },
    gaze: "hold",
    blink: "slow",
    transitionIn: 0.8,
    transitionOut: 1.0,
  },
  comforting: {
    name: "Comforting",
    blendShapes: { happy: 0.3, relaxed: 0.55, sad: 0.1 },
    headPose: { tiltZ: 0.10, nodX: 0.05 },
    gaze: "hold",
    blink: "slow",
    transitionIn: 0.8,
    transitionOut: 1.0,
  },
  disappointed: {
    name: "Disappointed",
    blendShapes: { sad: 0.5, angry: 0.1 },
    headPose: { nodX: 0.08 },
    gaze: "downcast",
    blink: "normal",
    transitionIn: 0.6,
    transitionOut: 0.8,
  },
  annoyed: {
    name: "Annoyed",
    blendShapes: { angry: 0.4, relaxed: 0.1 },
    headPose: { tiltZ: -0.04, turnY: 0.06 },
    gaze: "slow-drift",
    blink: "normal",
    transitionIn: 0.3,
    transitionOut: 0.5,
  },
  worried: {
    name: "Worried",
    blendShapes: { sad: 0.4, surprised: 0.2 },
    headPose: { nodX: 0.04 },
    gaze: "flutter",
    blink: "rapid",
    transitionIn: 0.4,
    transitionOut: 0.6,
  },
  thoughtful: {
    name: "Thoughtful",
    blendShapes: { relaxed: 0.3, sad: 0.1 },
    headPose: { tiltZ: 0.05, nodX: 0.03, turnY: 0.04 },
    gaze: "slow-drift",
    blink: "normal",
    transitionIn: 0.6,
    transitionOut: 0.6,
  },
  confident: {
    name: "Confident",
    blendShapes: { happy: 0.25, relaxed: 0.2 },
    headPose: { nodX: -0.03 },
    gaze: "hold",
    blink: "normal",
    transitionIn: 0.4,
    transitionOut: 0.5,
  },
  neutral: {
    name: "Neutral",
    blendShapes: {},
    gaze: "normal",
    blink: "normal",
    transitionIn: 0.5,
    transitionOut: 0.5,
  },
};

export type EmotionName = keyof typeof EMOTION_LIBRARY;
export const EMOTION_NAMES = Object.keys(EMOTION_LIBRARY) as EmotionName[];

// ─── Emotion Driver ──────────────────────────────────────────

export class EmotionDriver {
  private active: EmotionRecipe | null = null;
  private elapsed = 0;
  private duration = 0;
  private phase: "in" | "hold" | "out" | "idle" = "idle";
  private phaseTime = 0;

  private currentBlendShapes: Record<string, number> = {};
  private currentHeadPose = { tiltZ: 0, nodX: 0, turnY: 0 };

  private gazeTime = 0;
  private gazePhase = 0;

  private blinkOverrideActive = false;
  private blinkTimer = 0;
  private nextBlinkAt = 3;
  private halfLidValue = 0;

  private winkTimer = 0;
  private winkDuration = 0;
  private winkEye: "left" | "right" = "right";

  private headBone: THREE.Object3D | null = null;
  private neckBone: THREE.Object3D | null = null;
  private restHeadRotation = new THREE.Euler();
  private restNeckRotation = new THREE.Euler();
  private headInitialized = false;

  play(name: string, durationMs = 0, intensity = 1.0) {
    const recipe = EMOTION_LIBRARY[name];
    if (!recipe) {
      console.warn(`[EmotionDriver] Unknown emotion: "${name}"`);
      return;
    }

    const scaled: EmotionRecipe = {
      ...recipe,
      blendShapes: { ...recipe.blendShapes },
    };
    for (const key in scaled.blendShapes) {
      scaled.blendShapes[key]! *= intensity;
    }
    if (scaled.micro) {
      scaled.micro = scaled.micro.map(kf => ({
        ...kf,
        blendShapes: Object.fromEntries(
          Object.entries(kf.blendShapes).map(([k, v]) => [k, (v ?? 0) * intensity])
        ),
      }));
    }

    this.active = scaled;
    this.elapsed = 0;
    this.duration = durationMs / 1000;
    this.phase = "in";
    this.phaseTime = 0;
    this.gazeTime = 0;
    this.gazePhase = 0;

    this.blinkOverrideActive = recipe.blink !== "normal";
    this.blinkTimer = 0;
    this.halfLidValue = 0;
    this.nextBlinkAt = this.getBlinkInterval(recipe.blink);

    if (recipe.blink === "wink") {
      this.winkTimer = 0.5 + Math.random() * 1.5;
      this.winkDuration = 0;
      this.winkEye = Math.random() > 0.5 ? "right" : "left";
    }
  }

  stop() {
    if (this.active && this.phase !== "out" && this.phase !== "idle") {
      this.phase = "out";
      this.phaseTime = 0;
    }
  }

  get isActive(): boolean {
    return this.phase !== "idle";
  }

  get currentEmotion(): string | null {
    return this.active?.name ?? null;
  }

  update(
    delta: number,
    expressionManager: ExpressionManager | undefined,
    humanoid: VRMHumanoid | undefined,
    lookAtTarget: THREE.Object3D,
    defaultLookAt: THREE.Vector3,
  ) {
    if (this.phase === "idle" || !this.active) return;

    this.elapsed += delta;
    this.phaseTime += delta;
    this.gazeTime += delta;

    if (!this.headInitialized && humanoid) {
      this.headBone = humanoid.getNormalizedBoneNode("head");
      this.neckBone = humanoid.getNormalizedBoneNode("neck");
      if (this.headBone) this.restHeadRotation.copy(this.headBone.rotation);
      if (this.neckBone) this.restNeckRotation.copy(this.neckBone.rotation);
      this.headInitialized = true;
    }

    const recipe = this.active;
    const transIn = recipe.transitionIn ?? 0.5;
    const transOut = recipe.transitionOut ?? 0.5;

    if (this.phase === "in" && this.phaseTime >= transIn) {
      this.phase = "hold";
      this.phaseTime = 0;
    }
    if (this.phase === "hold" && this.duration > 0 && this.elapsed >= this.duration - transOut) {
      this.phase = "out";
      this.phaseTime = 0;
    }
    if (this.phase === "out" && this.phaseTime >= transOut) {
      this.phase = "idle";
      this.active = null;
      this.headInitialized = false;
      if (expressionManager) {
        for (const key in this.currentBlendShapes) {
          expressionManager.setValue(key, 0);
        }
      }
      this.currentBlendShapes = {};
      this.currentHeadPose = { tiltZ: 0, nodX: 0, turnY: 0 };
      return;
    }

    let blend = 1;
    if (this.phase === "in") blend = easeInOut(Math.min(1, this.phaseTime / transIn));
    if (this.phase === "out") blend = 1 - easeInOut(Math.min(1, this.phaseTime / transOut));

    const targetShapes = this.computeTargetBlendShapes(recipe);

    if (expressionManager) {
      const allKeys = new Set([...Object.keys(targetShapes), ...Object.keys(this.currentBlendShapes)]);
      for (const key of allKeys) {
        const target = (targetShapes[key] ?? 0) * blend;
        const current = this.currentBlendShapes[key] ?? 0;
        const value = current + (target - current) * Math.min(1, delta * 6);
        this.currentBlendShapes[key] = value;
        if (value > 0.001) {
          expressionManager.setValue(key, value);
        } else if (current > 0.001) {
          expressionManager.setValue(key, 0);
          delete this.currentBlendShapes[key];
        }
      }
    }

    if (this.headBone) {
      const targetPose = this.computeTargetHeadPose(recipe);
      const lerpSpeed = Math.min(1, delta * 3);

      this.currentHeadPose.tiltZ += ((targetPose.tiltZ ?? 0) * blend - this.currentHeadPose.tiltZ) * lerpSpeed;
      this.currentHeadPose.nodX += ((targetPose.nodX ?? 0) * blend - this.currentHeadPose.nodX) * lerpSpeed;
      this.currentHeadPose.turnY += ((targetPose.turnY ?? 0) * blend - this.currentHeadPose.turnY) * lerpSpeed;

      this.headBone.rotation.set(
        this.restHeadRotation.x + this.currentHeadPose.nodX,
        this.restHeadRotation.y + this.currentHeadPose.turnY,
        this.restHeadRotation.z + this.currentHeadPose.tiltZ,
      );
    }

    this.updateGaze(delta, recipe, lookAtTarget, defaultLookAt, blend);

    if (this.blinkOverrideActive && expressionManager) {
      this.updateBlinkOverride(delta, recipe, expressionManager, blend);
    }
  }

  private computeTargetBlendShapes(recipe: EmotionRecipe): Record<string, number> {
    if (!recipe.micro || recipe.micro.length === 0) {
      return Object.fromEntries(
        Object.entries(recipe.blendShapes).filter((e): e is [string, number] => e[1] !== undefined)
      );
    }

    const cycleDuration = this.duration > 0 ? this.duration : 4;
    const t = (this.elapsed % cycleDuration) / cycleDuration;

    const kfs = recipe.micro;
    let before = kfs[0];
    let after = kfs[kfs.length - 1];
    let segmentT = 0;

    for (let i = 0; i < kfs.length - 1; i++) {
      if (t >= kfs[i].time && t <= kfs[i + 1].time) {
        before = kfs[i];
        after = kfs[i + 1];
        const segLen = after.time - before.time;
        segmentT = segLen > 0 ? (t - before.time) / segLen : 0;
        break;
      }
    }

    const result: Record<string, number> = Object.fromEntries(
      Object.entries(recipe.blendShapes).filter((e): e is [string, number] => e[1] !== undefined)
    );
    const allKeys = new Set([...Object.keys(before.blendShapes), ...Object.keys(after.blendShapes)]);
    for (const key of allKeys) {
      const a = before.blendShapes[key] ?? recipe.blendShapes[key] ?? 0;
      const b = after.blendShapes[key] ?? recipe.blendShapes[key] ?? 0;
      result[key] = a + (b - a) * easeInOut(segmentT);
    }

    return result;
  }

  private computeTargetHeadPose(recipe: EmotionRecipe): { tiltZ?: number; nodX?: number; turnY?: number } {
    if (!recipe.micro || recipe.micro.length === 0) {
      return recipe.headPose ?? {};
    }

    const cycleDuration = this.duration > 0 ? this.duration : 4;
    const t = (this.elapsed % cycleDuration) / cycleDuration;

    const kfs = recipe.micro;
    let before = kfs[0];
    let after = kfs[kfs.length - 1];
    let segmentT = 0;

    for (let i = 0; i < kfs.length - 1; i++) {
      if (t >= kfs[i].time && t <= kfs[i + 1].time) {
        before = kfs[i];
        after = kfs[i + 1];
        const segLen = after.time - before.time;
        segmentT = segLen > 0 ? (t - before.time) / segLen : 0;
        break;
      }
    }

    const basePose = recipe.headPose ?? {};
    const a = before.headPose ?? basePose;
    const b = after.headPose ?? basePose;
    const s = easeInOut(segmentT);

    return {
      tiltZ: (a.tiltZ ?? basePose.tiltZ ?? 0) + ((b.tiltZ ?? basePose.tiltZ ?? 0) - (a.tiltZ ?? basePose.tiltZ ?? 0)) * s,
      nodX: (a.nodX ?? basePose.nodX ?? 0) + ((b.nodX ?? basePose.nodX ?? 0) - (a.nodX ?? basePose.nodX ?? 0)) * s,
      turnY: (a.turnY ?? basePose.turnY ?? 0) + ((b.turnY ?? basePose.turnY ?? 0) - (a.turnY ?? basePose.turnY ?? 0)) * s,
    };
  }

  private updateGaze(
    delta: number,
    recipe: EmotionRecipe,
    lookAtTarget: THREE.Object3D,
    defaultPos: THREE.Vector3,
    blend: number,
  ) {
    const lerpSpeed = Math.min(1, delta * 2.5);

    switch (recipe.gaze) {
      case "hold":
        lookAtTarget.position.lerp(new THREE.Vector3(0, 1.4, 3), lerpSpeed);
        break;
      case "avert-return": {
        const cycle = 3.5;
        const t = (this.gazeTime % cycle) / cycle;
        if (t < 0.4) {
          lookAtTarget.position.lerp(new THREE.Vector3(0, 1.4, 3), lerpSpeed);
        } else if (t < 0.6) {
          lookAtTarget.position.lerp(new THREE.Vector3(0.8, 1.0, 2.5), lerpSpeed * 0.6);
        } else {
          lookAtTarget.position.lerp(new THREE.Vector3(0, 1.4, 3), lerpSpeed * 0.4);
        }
        break;
      }
      case "slow-drift": {
        const dx = Math.sin(this.gazeTime * 0.5) * 0.6;
        const dy = Math.cos(this.gazeTime * 0.35) * 0.2;
        lookAtTarget.position.lerp(new THREE.Vector3(dx, 1.3 + dy, 2.5), lerpSpeed * 0.5);
        break;
      }
      case "flutter": {
        const flickInterval = 0.8 + Math.sin(this.gazeTime * 2.3) * 0.3;
        const fx = Math.sin(this.gazeTime * (1 / flickInterval) * 3) * 0.4;
        const fy = Math.cos(this.gazeTime * (1 / flickInterval) * 2) * 0.15;
        lookAtTarget.position.lerp(new THREE.Vector3(fx, 1.35 + fy, 2.8), lerpSpeed);
        break;
      }
      case "downcast":
        lookAtTarget.position.lerp(new THREE.Vector3(0, 0.6, 2), lerpSpeed * 0.6);
        break;
      case "up-through":
        lookAtTarget.position.lerp(new THREE.Vector3(0, 1.8, 3), lerpSpeed * 0.5);
        break;
      case "normal":
      default:
        lookAtTarget.position.lerp(defaultPos, lerpSpeed);
        break;
    }

    if (blend < 1) {
      lookAtTarget.position.lerp(defaultPos, 1 - blend);
    }
  }

  private updateBlinkOverride(
    delta: number,
    recipe: EmotionRecipe,
    expressionManager: ExpressionManager,
    blend: number,
  ) {
    this.blinkTimer += delta;

    switch (recipe.blink) {
      case "slow": {
        if (this.blinkTimer >= this.nextBlinkAt) {
          this.blinkTimer = 0;
          this.nextBlinkAt = 4 + Math.random() * 3;
        }
        if (this.blinkTimer < 0.6) {
          const t = this.blinkTimer / 0.6;
          const blinkVal = t < 0.5 ? t * 2 : 2 - t * 2;
          expressionManager.setValue("blink", blinkVal * blend);
        }
        break;
      }
      case "rapid": {
        if (this.blinkTimer >= this.nextBlinkAt) {
          this.blinkTimer = 0;
          this.nextBlinkAt = 1 + Math.random() * 1.5;
        }
        if (this.blinkTimer < 0.15) {
          const t = this.blinkTimer / 0.15;
          const blinkVal = t < 0.5 ? t * 2 : 2 - t * 2;
          expressionManager.setValue("blink", blinkVal * blend);
        }
        break;
      }
      case "half": {
        const targetHalf = 0.35;
        this.halfLidValue += (targetHalf - this.halfLidValue) * Math.min(1, delta * 3);
        expressionManager.setValue("blink", this.halfLidValue * blend);
        if (this.blinkTimer >= this.nextBlinkAt) {
          this.blinkTimer = 0;
          this.nextBlinkAt = 5 + Math.random() * 4;
        }
        if (this.blinkTimer < 0.5) {
          const t = this.blinkTimer / 0.5;
          const fullBlink = t < 0.5 ? t * 2 : 2 - t * 2;
          const combined = Math.max(this.halfLidValue, fullBlink);
          expressionManager.setValue("blink", combined * blend);
        }
        break;
      }
      case "wink": {
        this.winkTimer -= delta;
        if (this.winkTimer <= 0 && this.winkDuration === 0) {
          this.winkDuration = 0.35;
        }
        if (this.winkDuration > 0) {
          this.winkDuration -= delta;
          const t = 1 - (this.winkDuration / 0.35);
          const winkVal = t < 0.5 ? t * 2 : 2 - t * 2;
          const eyeName = this.winkEye === "right" ? "blinkRight" : "blinkLeft";
          expressionManager.setValue(eyeName, winkVal * blend);
          if (this.winkDuration <= 0) {
            expressionManager.setValue(eyeName, 0);
          }
        }
        break;
      }
    }
  }

  private getBlinkInterval(pattern: BlinkPattern): number {
    switch (pattern) {
      case "slow": return 4 + Math.random() * 3;
      case "rapid": return 1 + Math.random() * 1.5;
      case "half": return 5 + Math.random() * 4;
      case "wink": return 999;
      default: return 3 + Math.random() * 3;
    }
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
