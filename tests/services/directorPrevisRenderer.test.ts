import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDefaultPrevisScene } from '../../src/services/directorPrevisSchema';
import { configurePrevisShadow, previsAspectRatio, samplePrevisCamera, samplePrevisObject } from '../../src/services/directorPrevisRenderer';

describe('previs camera and blocking interpolation', () => {
  it('preserves exact endpoints and holds outside the timeline', () => {
    const scene = createDefaultPrevisScene();
    expect(samplePrevisCamera(scene, -1)).toEqual(scene.camera.keyframes[0]);
    expect(samplePrevisCamera(scene, 20)).toEqual(scene.camera.keyframes.at(-1));
    for (const frame of scene.camera.keyframes) expect(samplePrevisCamera(scene, frame.time)).toEqual(frame);
  });

  it('moves actor and camera on the same timeline and interpolates lens and roll', () => {
    const scene = createDefaultPrevisScene();
    scene.camera.keyframes = [
      { time: 0, position: [0, 2, 6], target: [0, 1, 0], focalLength: 35, roll: -10 },
      { time: 8, position: [8, 4, 6], target: [8, 1, 0], focalLength: 85, roll: 10 },
    ];
    expect(samplePrevisCamera(scene, 4)).toEqual({ time: 4, position: [4, 3, 6], target: [4, 1, 0], focalLength: 60, roll: 0 });
    expect(samplePrevisObject(scene.objects[2], 4, false).position).toEqual([0, 0, 0]);
    expect(samplePrevisObject(scene.objects[0], 4, false).position).toEqual(scene.objects[0].position);
  });

  it('uses segment easing without changing endpoint poses', () => {
    const scene = createDefaultPrevisScene();
    const actor = scene.objects[2];
    expect(samplePrevisObject(actor, 2, false).position[2]).toBe(2);
    expect(samplePrevisObject(actor, 2, true).position[2]).toBe(2.75);
    expect(samplePrevisObject(actor, 8, true)).toEqual(actor.keyframes.at(-1));
  });

  it('keeps wide, portrait and cinema output ratios explicit', () => {
    const scene = createDefaultPrevisScene();
    expect(previsAspectRatio(scene)).toBeCloseTo(16 / 9);
    expect(previsAspectRatio({ ...scene, aspectRatio: '9:16' })).toBeCloseTo(9 / 16);
    expect(previsAspectRatio({ ...scene, aspectRatio: '2.39:1' })).toBe(2.39);
  });
});

describe('previs shadow coverage and precision', () => {
  it.each([512, 1024, 4096])('keeps moving geometry and its ground shadows inside the frustum at GPU limit %s', (limit) => {
    const bounds = new THREE.Box3(new THREE.Vector3(-2.6, 0, -8), new THREE.Vector3(2.6, 3, 8));
    const light = new THREE.DirectionalLight();
    configurePrevisShadow(light, bounds, limit);
    light.shadow.updateMatrices(light);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(
      light.shadow.camera.projectionMatrix, light.shadow.camera.matrixWorldInverse,
    ));
    // Independent points along the walking route, tall walls and their projected ground shadows.
    for (const x of [-2.6, 0, 2.6]) for (const z of [-8, -4, 0, 4, 8]) for (const y of [0, 1.75, 3]) {
      expect(frustum.containsPoint(new THREE.Vector3(x, y, z))).toBe(true);
      expect(frustum.containsPoint(new THREE.Vector3(x - (y + 0.01) * 0.375, -0.01, z - (y + 0.01) * 0.5))).toBe(true);
    }
    expect(bounds.min.toArray()).toEqual([-2.6, 0, -8]);
    expect(light.shadow.mapSize.x).toBeLessThanOrEqual(limit);
    expect(light.shadow.mapSize.x).toBeLessThanOrEqual(2048);
    expect(light.shadow.normalBias).toBeGreaterThan(0);
    expect(light.shadow.normalBias).toBeLessThanOrEqual(0.03);
    // The old volume covered ±span and far=span*4, wasting depth and texels on camera space.
    const span = bounds.getSize(new THREE.Vector3()).length();
    const camera = light.shadow.camera;
    expect(camera.right - camera.left).toBeLessThan(span * 2);
    expect(camera.top - camera.bottom).toBeLessThan(span * 2);
    expect(camera.far - camera.near).toBeLessThan(span * 4);
  });

  it.each([0.05, 500])('keeps finite coverage and bounded contact offsets for scene scale %s', (scale) => {
    const center = new THREE.Vector3(400, 0, -400);
    const bounds = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(scale, scale, scale));
    const light = new THREE.DirectionalLight();
    configurePrevisShadow(light, bounds, 2048);
    const camera = light.shadow.camera;
    expect([camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far, light.shadow.normalBias].every(Number.isFinite)).toBe(true);
    expect(camera.far).toBeGreaterThan(camera.near);
    expect(light.shadow.normalBias).toBeLessThanOrEqual(0.03);
  });

  it('handles an empty scene envelope without an invalid shadow camera', () => {
    const light = new THREE.DirectionalLight();
    configurePrevisShadow(light, new THREE.Box3(), 4096);
    expect(light.shadow.camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
    expect(light.shadow.camera.far).toBeGreaterThan(light.shadow.camera.near);
  });
});
