/**
 * VRM model loader — matches FHAE avatar-viewport patterns.
 * Uses GLTFLoader + VRMLoaderPlugin to load a VRM avatar into the scene.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';

const MODEL_PATH = '/avatar/dj-placeholder.vrm';

export async function loadAvatar(scene: THREE.Scene): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(MODEL_PATH);
  const vrm = gltf.userData.vrm as VRM | undefined;

  if (!vrm) {
    throw new Error('File is not a valid VRM model');
  }

  // Enable shadows and disable frustum culling on all meshes
  vrm.scene.traverse((obj: THREE.Object3D) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }
  });

  // VRM models face +Z by default; rotate to face camera (-Z)
  vrm.scene.rotation.y = Math.PI;

  // Nudge avatar down so shoe soles press firmly onto platform surface
  vrm.scene.position.y = -0.02;

  scene.add(vrm.scene);

  // Initialize bone transforms
  vrm.update(0);

  return vrm;
}
