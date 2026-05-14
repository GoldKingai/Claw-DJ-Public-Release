/**
 * Animation Retargeting — Maps bone names from Mixamo FBX animations
 * onto VRM humanoid bone names. Copied from FHAE.
 */

import * as THREE from 'three';

// ────────────────────────────────────────────────────────────
//  VRM Humanoid Bone Names (the target)
// ────────────────────────────────────────────────────────────

export type VRMBoneName =
  | "hips" | "spine" | "chest" | "upperChest" | "neck" | "head"
  | "leftShoulder" | "leftUpperArm" | "leftLowerArm" | "leftHand"
  | "rightShoulder" | "rightUpperArm" | "rightLowerArm" | "rightHand"
  | "leftUpperLeg" | "leftLowerLeg" | "leftFoot" | "leftToes"
  | "rightUpperLeg" | "rightLowerLeg" | "rightFoot" | "rightToes"
  | "leftThumbMetacarpal" | "leftThumbProximal" | "leftThumbDistal"
  | "leftIndexProximal" | "leftIndexIntermediate" | "leftIndexDistal"
  | "leftMiddleProximal" | "leftMiddleIntermediate" | "leftMiddleDistal"
  | "leftRingProximal" | "leftRingIntermediate" | "leftRingDistal"
  | "leftLittleProximal" | "leftLittleIntermediate" | "leftLittleDistal"
  | "rightThumbMetacarpal" | "rightThumbProximal" | "rightThumbDistal"
  | "rightIndexProximal" | "rightIndexIntermediate" | "rightIndexDistal"
  | "rightMiddleProximal" | "rightMiddleIntermediate" | "rightMiddleDistal"
  | "rightRingProximal" | "rightRingIntermediate" | "rightRingDistal"
  | "rightLittleProximal" | "rightLittleIntermediate" | "rightLittleDistal";

// ────────────────────────────────────────────────────────────
//  Mixamo bone name → VRM humanoid bone name
// ────────────────────────────────────────────────────────────

const MIXAMO_BASE: Record<string, VRMBoneName> = {
  "Hips": "hips",
  "Spine": "spine",
  "Spine1": "chest",
  "Spine2": "upperChest",
  "Neck": "neck",
  "Head": "head",
  "LeftShoulder": "leftShoulder",
  "LeftArm": "leftUpperArm",
  "LeftForeArm": "leftLowerArm",
  "LeftHand": "leftHand",
  "RightShoulder": "rightShoulder",
  "RightArm": "rightUpperArm",
  "RightForeArm": "rightLowerArm",
  "RightHand": "rightHand",
  "LeftUpLeg": "leftUpperLeg",
  "LeftLeg": "leftLowerLeg",
  "LeftFoot": "leftFoot",
  "LeftToeBase": "leftToes",
  "RightUpLeg": "rightUpperLeg",
  "RightLeg": "rightLowerLeg",
  "RightFoot": "rightFoot",
  "RightToeBase": "rightToes",
  // Left hand fingers
  "LeftHandThumb1": "leftThumbMetacarpal",
  "LeftHandThumb2": "leftThumbProximal",
  "LeftHandThumb3": "leftThumbDistal",
  "LeftHandIndex1": "leftIndexProximal",
  "LeftHandIndex2": "leftIndexIntermediate",
  "LeftHandIndex3": "leftIndexDistal",
  "LeftHandMiddle1": "leftMiddleProximal",
  "LeftHandMiddle2": "leftMiddleIntermediate",
  "LeftHandMiddle3": "leftMiddleDistal",
  "LeftHandRing1": "leftRingProximal",
  "LeftHandRing2": "leftRingIntermediate",
  "LeftHandRing3": "leftRingDistal",
  "LeftHandPinky1": "leftLittleProximal",
  "LeftHandPinky2": "leftLittleIntermediate",
  "LeftHandPinky3": "leftLittleDistal",
  // Right hand fingers
  "RightHandThumb1": "rightThumbMetacarpal",
  "RightHandThumb2": "rightThumbProximal",
  "RightHandThumb3": "rightThumbDistal",
  "RightHandIndex1": "rightIndexProximal",
  "RightHandIndex2": "rightIndexIntermediate",
  "RightHandIndex3": "rightIndexDistal",
  "RightHandMiddle1": "rightMiddleProximal",
  "RightHandMiddle2": "rightMiddleIntermediate",
  "RightHandMiddle3": "rightMiddleDistal",
  "RightHandRing1": "rightRingProximal",
  "RightHandRing2": "rightRingIntermediate",
  "RightHandRing3": "rightRingDistal",
  "RightHandPinky1": "rightLittleProximal",
  "RightHandPinky2": "rightLittleIntermediate",
  "RightHandPinky3": "rightLittleDistal",
};

// Build full mapping with all variants FBXLoader might produce
const MIXAMO_TO_VRM: Record<string, VRMBoneName> = {};
for (const [shortName, vrmName] of Object.entries(MIXAMO_BASE)) {
  MIXAMO_TO_VRM[`mixamorig:${shortName}`] = vrmName;
  MIXAMO_TO_VRM[`mixamorig${shortName}`] = vrmName;
  MIXAMO_TO_VRM[shortName] = vrmName;
}

// ────────────────────────────────────────────────────────────
//  Auto-detect source skeleton
// ────────────────────────────────────────────────────────────

function detectSourceFormat(clip: THREE.AnimationClip): "mixamo" | "unknown" {
  for (const track of clip.tracks) {
    if (track.name.includes("mixamorig")) return "mixamo";
  }
  return "unknown";
}

// ────────────────────────────────────────────────────────────
//  Core retargeting — three-vrm quaternion formula
// ────────────────────────────────────────────────────────────

interface VRMHumanoid {
  getNormalizedBoneNode(name: string): THREE.Object3D | null;
}

/**
 * Build a retargeted THREE.AnimationClip from a Mixamo FBX clip.
 * Uses the three-vrm reference formula:
 *   result = mixamoParentWorldQ * animQ * mixamoBoneWorldInvQ
 */
export function buildMixerClip(
  clip: THREE.AnimationClip,
  humanoid: VRMHumanoid,
  name: string,
  fbxScene?: THREE.Group,
): THREE.AnimationClip | null {
  const format = detectSourceFormat(clip);
  if (format === "unknown") {
    console.warn("[avatar] Unknown animation format:", name);
    return null;
  }

  // Capture FBX bone rest quaternions
  const fbxBoneWorldQuats = new Map<string, THREE.Quaternion>();
  const fbxBoneParentWorldQuats = new Map<string, THREE.Quaternion>();
  if (fbxScene) {
    fbxScene.updateWorldMatrix(true, true);
    fbxScene.traverse((obj) => {
      if ((obj as any).isBone || obj.type === "Bone") {
        const wq = new THREE.Quaternion();
        obj.getWorldQuaternion(wq);
        fbxBoneWorldQuats.set(obj.name, wq);
        if (obj.parent) {
          const pwq = new THREE.Quaternion();
          obj.parent.getWorldQuaternion(pwq);
          fbxBoneParentWorldQuats.set(obj.name, pwq);
        }
      }
    });
  }

  const retargetedTracks: THREE.KeyframeTrack[] = [];
  let mappedCount = 0;

  for (const track of clip.tracks) {
    const lastDot = track.name.lastIndexOf(".");
    if (lastDot < 0) continue;
    const property = track.name.substring(lastDot);

    // Only quaternion tracks — position/scale don't transfer between skeletons
    if (property !== ".quaternion") continue;

    const pathBefore = track.name.substring(0, lastDot);
    const segments = pathBefore.split(".");
    const sourceBone = segments[segments.length - 1];

    let vrmBone = MIXAMO_TO_VRM[sourceBone];
    if (!vrmBone) {
      for (const seg of segments) {
        if (MIXAMO_TO_VRM[seg]) { vrmBone = MIXAMO_TO_VRM[seg]; break; }
      }
    }
    if (!vrmBone) continue;

    const boneNode = humanoid.getNormalizedBoneNode(vrmBone);
    if (!boneNode) continue;

    // Apply three-vrm retargeting formula
    const mixamoWorldQ = fbxBoneWorldQuats.get(sourceBone);
    const mixamoParentWorldQ = fbxBoneParentWorldQuats.get(sourceBone);

    if (!mixamoWorldQ || !mixamoParentWorldQ) continue;

    const mixamoWorldInv = new THREE.Quaternion().copy(mixamoWorldQ).invert();
    const values = new Float32Array(track.values);
    const numKeys = values.length / 4;
    const _q = new THREE.Quaternion();

    for (let i = 0; i < numKeys; i++) {
      const o = i * 4;
      _q.set(values[o], values[o + 1], values[o + 2], values[o + 3]);
      _q.premultiply(mixamoParentWorldQ);
      _q.multiply(mixamoWorldInv);
      values[o]     = _q.x;
      values[o + 1] = _q.y;
      values[o + 2] = _q.z;
      values[o + 3] = _q.w;
    }

    retargetedTracks.push(
      new THREE.QuaternionKeyframeTrack(boneNode.name + ".quaternion", Array.from(track.times), Array.from(values))
    );
    mappedCount++;
  }

  if (retargetedTracks.length === 0) {
    console.warn(`[avatar] No tracks mapped for "${name}"`);
    return null;
  }

  const duration = clip.duration > 0
    ? clip.duration
    : Math.max(...retargetedTracks.map(t => t.times[t.times.length - 1]));

  console.log(`[avatar] Retargeted "${name}": ${mappedCount} tracks, ${duration.toFixed(1)}s`);

  return new THREE.AnimationClip(name, duration, retargetedTracks);
}

// ────────────────────────────────────────────────────────────
//  Animation catalog
// ────────────────────────────────────────────────────────────

export type AnimationCategory = "idle" | "talking" | "dance" | "gesture" | "emotion" | "djing" | "disabled";

export interface AnimationEntry {
  name: string;
  url: string;
  category: AnimationCategory;
  loop?: boolean;
}

export interface AnimationInfo {
  name: string;
  category: AnimationCategory;
  clip: THREE.AnimationClip;
  loop: boolean;
}

export const ANIMATION_CATALOG: AnimationEntry[] = [
  // Idle animations — cycled automatically
  { name: "idle",            url: "./animations/idle.fbx",            category: "idle",    loop: true },
  { name: "standing-idle",   url: "./animations/standing-idle.fbx",   category: "idle",    loop: true },
  { name: "dwarf-idle",      url: "./animations/dwarf-idle.fbx",      category: "idle",    loop: true },
  { name: "look-around",     url: "./animations/look-around.fbx",     category: "idle",    loop: false },
  // Talking
  { name: "talking",         url: "./animations/talking.fbx",         category: "talking", loop: true },
  // DJing — cycled while music is playing
  { name: "hip-hop-dancing",   url: "./animations/hip-hop-dancing.fbx",   category: "djing", loop: true },
  { name: "hip-hop-dancing-1", url: "./animations/hip-hop-dancing-1.fbx", category: "djing", loop: true },
  { name: "hip-hop-dancing-2", url: "./animations/hip-hop-dancing-2.fbx", category: "djing", loop: true },
  { name: "arms-hiphop",       url: "./animations/arms-hiphop.fbx",       category: "djing", loop: true },
  { name: "samba-dancing",     url: "./animations/samba-dancing.fbx",     category: "disabled", loop: true },
  { name: "twerk",             url: "./animations/twerk.fbx",             category: "djing", loop: true },
  { name: "breakdance-ready",  url: "./animations/breakdance-ready.fbx",  category: "djing", loop: true },
  // Dance
  { name: "belly-dance",     url: "./animations/belly-dance.fbx",     category: "dance",   loop: true },
  { name: "snake-hiphop",    url: "./animations/snake-hiphop.fbx",    category: "dance",   loop: true },
  // Emotion
  { name: "angry",           url: "./animations/angry.fbx",           category: "emotion", loop: false },
];
