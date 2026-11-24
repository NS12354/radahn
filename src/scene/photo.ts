/**
 * Photo mode: path-trace the current view (three-gpu-pathtracer) for a
 * near-photographic image: real global illumination, soft area shadows,
 * glossy reflections, depth-correct ambient occlusion. Renders progressively;
 * the longer it runs the cleaner it gets. The live viewport pauses meanwhile.
 */
import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import type { Viewport } from './viewport';

// three-gpu-pathtracer reads scene.environmentRotation / backgroundRotation (three r162+); give every Scene them on r160
for (const k of ['environmentRotation', 'backgroundRotation']) if (!(k in new THREE.Scene())) Object.defineProperty(THREE.Scene.prototype, k, { configurable: true, get(this: any) { return (this['_' + k] ??= new THREE.Euler()); }, set(this: any, v) { this['_' + k] = v; } });

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
  // physical materials default to attenuationDistance = Infinity, which packs as NaN on the GPU (renders black): use a huge finite value
  const fixed: { m: THREE.MeshPhysicalMaterial; cc: number; ad: number }[] = [];
  scene.traverse((o: any) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; for (const m of ms) if (m.isMeshPhysicalMaterial && !fixed.some(f => f.m === m)) { fixed.push({ m, cc: m.clearcoat, ad: m.attenuationDistance }); if (!isFinite(m.attenuationDistance)) m.attenuationDistance = 1e9; m.clearcoat = 0; } });
  const pt = new WebGLPathTracer(V.renderer);
  pt.tiles.set(2, 2);
  pt.bounces = 6; pt.filterGlossyFactor = 0.4; pt.renderDelay = 0; pt.fadeDuration = 0; pt.minSamples = 1;
  pt.setScene(scene, V.camera);
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    pt.renderSample();
    onSample((pt as any).isCompiling ? -1 : Math.floor(pt.samples));
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
      for (const f of fixed) { f.m.attenuationDistance = f.ad; f.m.clearcoat = f.cc; }
      if (floor) { scene.remove(floor); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); }
      V.paused = false;
    },
  };
}
