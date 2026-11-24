/**
 * Photo mode: path-trace the current view (three-gpu-pathtracer) for a
 * near-photographic image: real global illumination, soft area shadows,
 * glossy reflections, depth-correct ambient occlusion. Renders progressively;
 * the longer it runs the cleaner it gets. The live viewport pauses meanwhile.
 */
import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import type { Viewport } from './viewport';

export interface PhotoSession { samples(): number; stop(): void; save(): string }

export function startPhoto(V: Viewport, onSample: (n: number) => void, target = 256): PhotoSession {
  V.paused = true;
  const scene = V.scene;
  // the path tracer wants an equirect environment and a real floor (the shadow-catcher is a raster trick)
  const env = new GradientEquirectTexture(512);
  env.topColor.set(0xffffff); env.bottomColor.set(0x5a5c63); env.exponent = 1.4; env.update();
  const prev = { env: scene.environment, bg: scene.background, envI: (scene as any).environmentIntensity };
  const hidden: THREE.Object3D[] = [];
  scene.traverse(o => { if (o.name === '__ground' || (o as any).material?.map?.isCanvasTexture && (o as any).material?.transparent && o.userData.noShadowCast) { if (o.visible) { hidden.push(o); o.visible = false; } } });
  const ground = scene.getObjectByName('__ground') as THREE.Mesh | undefined;
  let floor: THREE.Mesh | null = null;
  if (ground && hidden.includes(ground)) {
    floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshPhysicalMaterial({ color: 0x8c8d92, roughness: 0.6 }));
    floor.rotation.x = -Math.PI / 2; floor.position.copy(ground.position); floor.scale.copy(ground.scale);
    scene.add(floor);
  }
  scene.environment = env; scene.background = env; (scene as any).environmentIntensity = 1;
  (scene as any).backgroundBlurriness = 0.4;
  const pt = new WebGLPathTracer(V.renderer);
  pt.tiles.set(2, 2);
  pt.bounces = 6; pt.filterGlossyFactor = 0.4; pt.renderDelay = 0; pt.fadeDuration = 0; pt.minSamples = 1;
  pt.setScene(scene, V.camera);
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    pt.renderSample();
    onSample(pt.isCompiling ? -1 : Math.floor(pt.samples));
    if (pt.samples < target) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    samples: () => pt.samples,
    save: () => V.renderer.domElement.toDataURL('image/png'),
    stop() {
      stopped = true; pt.dispose(); env.dispose();
      scene.environment = prev.env; scene.background = prev.bg; (scene as any).environmentIntensity = prev.envI; (scene as any).backgroundBlurriness = 0;
      for (const o of hidden) o.visible = true;
      if (floor) { scene.remove(floor); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); }
      V.paused = false;
    },
  };
}
