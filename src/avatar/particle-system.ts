/**
 * Background particle effects — digital dust / data motes.
 * Creates floating cyan-tinted particles that drift upward with slight random motion.
 */

import * as THREE from 'three';

const PARTICLE_COUNT = 150;
const SPAWN_RANGE = { x: 4, y: 3, z: 3 }; // volume in which particles spawn
const DRIFT_SPEED = 0.08; // base upward drift speed
const PARTICLE_SIZE = 0.8; // small data motes

interface ParticleState {
  positions: Float32Array;
  velocities: Float32Array;
  alphas: Float32Array;
  geometry: THREE.BufferGeometry;
}

/**
 * Create the particle system and add it to the scene.
 * Returns an update function to call each frame.
 */
export function createParticleSystem(scene: THREE.Scene): { update: (delta: number) => void } {
  const state = initParticles();
  const points = createPointsMesh(state);
  scene.add(points);

  return {
    update(delta: number) {
      updateParticles(state, delta);
    },
  };
}

function initParticles(): ParticleState {
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const velocities = new Float32Array(PARTICLE_COUNT * 3);
  const alphas = new Float32Array(PARTICLE_COUNT);
  const sizes = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;

    // Random position within spawn volume
    positions[i3] = (Math.random() - 0.5) * SPAWN_RANGE.x * 2;
    positions[i3 + 1] = (Math.random() - 0.5) * SPAWN_RANGE.y * 2;
    positions[i3 + 2] = (Math.random() - 0.5) * SPAWN_RANGE.z * 2 - 1; // slightly behind avatar

    // Random velocity — mostly upward with slight lateral drift
    velocities[i3] = (Math.random() - 0.5) * 0.05;
    velocities[i3 + 1] = DRIFT_SPEED * (0.5 + Math.random() * 0.5);
    velocities[i3 + 2] = (Math.random() - 0.5) * 0.03;

    // Random alpha for varied brightness
    alphas[i] = 0.15 + Math.random() * 0.85;

    // Slight size variation
    sizes[i] = PARTICLE_SIZE * (0.5 + Math.random() * 0.5);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  return { positions, velocities, alphas, geometry };
}

function createPointsMesh(state: ParticleState): THREE.Points {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x44ddff) },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      attribute float size;
      varying float vAlpha;

      void main() {
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (80.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        // Soft circular particle
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;
        float softness = 1.0 - smoothstep(0.2, 0.5, dist);
        gl_FragColor = vec4(uColor, vAlpha * softness * 0.25);
      }
    `,
  });

  return new THREE.Points(state.geometry, material);
}

function updateParticles(state: ParticleState, delta: number): void {
  const { positions, velocities, geometry } = state;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;

    // Apply velocity
    positions[i3] += velocities[i3] * delta;
    positions[i3 + 1] += velocities[i3 + 1] * delta;
    positions[i3 + 2] += velocities[i3 + 2] * delta;

    // Add slight random jitter
    positions[i3] += (Math.random() - 0.5) * 0.003;
    positions[i3 + 2] += (Math.random() - 0.5) * 0.002;

    // Wrap particles that drift out of bounds
    if (positions[i3 + 1] > SPAWN_RANGE.y) {
      positions[i3 + 1] = -SPAWN_RANGE.y;
      positions[i3] = (Math.random() - 0.5) * SPAWN_RANGE.x * 2;
      positions[i3 + 2] = (Math.random() - 0.5) * SPAWN_RANGE.z * 2 - 1;
    }
  }

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  posAttr.needsUpdate = true;
}
