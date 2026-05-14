/**
 * DJ booth lighting rig — based on FHAE lighting patterns.
 * Key + Fill + Rim + Ambient for balanced portrait lighting,
 * plus beat-reactive rim light pulsing.
 */

import * as THREE from 'three';

let rimLight: THREE.DirectionalLight | null = null;
let baseRimIntensity = 0.5;

/**
 * Set up the full lighting rig matching FHAE's proven setup.
 * Key (1.0) + Fill (0.4) + Rim (0.5) + Ambient (0.6)
 */
export function setupLighting(scene: THREE.Scene): void {
  // Key light — neutral white, from upper-right (FHAE: 1.0 intensity)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(2, 3, 2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 10;
  keyLight.shadow.bias = -0.002;
  scene.add(keyLight);

  // Fill light — neutral, from left (FHAE: 0.4 intensity)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-2, 2, 1);
  scene.add(fillLight);

  // Rim light — cool cyan from behind (FHAE: 0x88ccdd)
  rimLight = new THREE.DirectionalLight(0x88ccdd, baseRimIntensity);
  rimLight.position.set(0, 2, -2);
  scene.add(rimLight);

  // Ambient — neutral base illumination (FHAE: 0.6 intensity)
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
}

/**
 * Pulse the rim light intensity for beat-reactive effects.
 */
export function pulseRimLight(intensity: number): void {
  if (rimLight) {
    rimLight.intensity = intensity;
  }
}

/**
 * Reset the rim light to its base intensity.
 */
export function resetRimLight(): void {
  if (rimLight) {
    rimLight.intensity = baseRimIntensity;
  }
}
