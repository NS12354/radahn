import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type Quality = 'high' | 'fast';

/** Can this browser make a WebGL context? (Checked before building the renderer.) */
export function webglAvailable(): { ok: true } | { ok: false; why: string } {
  try {
    if (typeof WebGLRenderingContext === 'undefined') return { ok: false, why: 'This browser has no WebGL support.' };
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return { ok: false, why: 'WebGL is turned off or blocked (browser settings, a policy, or the graphics driver).' };
    (gl as any).getExtension?.('WEBGL_lose_context')?.loseContext();
    return { ok: true };
  } catch (e: any) { return { ok: false, why: `WebGL failed to start: ${e?.message ?? e}` }; }
}

/**
 * Stands in for the WebGL renderer when 3D can't run: it draws nothing, but the scene,
 * picking maths, simulation ticks and the rest of the app keep working.
 */
function nullRenderer(): THREE.WebGLRenderer {
  const canvas = document.createElement('canvas'); let pr = 1;
  return {
    domElement: canvas, shadowMap: { enabled: false, type: THREE.PCFSoftShadowMap }, outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, info: { render: {}, memory: {} },
    setPixelRatio(v: number) { pr = v; }, getPixelRatio: () => pr,
    setSize(w: number, h: number) { canvas.width = w; canvas.height = h; },
    render() {}, dispose() {}, getContext: () => null,
  } as unknown as THREE.WebGLRenderer;
}

/**
 * Renderer, camera, lighting and picking.
 *
 * Looks: physically based materials lit by a studio environment (softboxes),
 * a key light with soft shadows fitted to whatever is in view, a shadow-catcher
 * floor with a soft contact shadow, ground-truth ambient occlusion (GTAO) for
 * contact darkening in crevices, gentle bloom for LEDs and screens, and ACES
 * tone mapping. "Fast" (used while an emulator needs the CPU) renders directly
 * with shadows but without post-processing. Photo mode path-traces the scene
 * (photo.ts) for a near-photographic still.
 */
export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  controls: OrbitControls;
  quality: Quality = 'high';
  /** Set by the electronics panel while an emulator runs. */
  throttle = false;
  /** Pause normal rendering (photo mode draws into the canvas itself). */
  paused = false;
  key!: THREE.DirectionalLight;
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private ray = new THREE.Raycaster();
  private tickers: ((dt: number, now: number) => void)[] = [];
  private last = performance.now();
  private shadowT = 0;
  private ground!: THREE.Mesh;
  private contact!: THREE.Mesh;

  /** Why 3D isn't drawing (null while it works). The rest of the app keeps going either way. */
  failure: string | null = null;
  /** Told when 3D stops or starts drawing (the studio shows or hides its notice). */
  onFailure: (why: string | null) => void = () => {};

  constructor(public el: HTMLElement) {
    const gl = webglAvailable();
    let renderer: THREE.WebGLRenderer | null = null;
    if (gl.ok) { try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch (e: any) { this.failure = `The 3D renderer failed to start: ${e?.message ?? e}`; } }
    else this.failure = gl.why;
    this.renderer = renderer ?? nullRenderer();
    if (!renderer) console.warn('[formframe] 3D view unavailable:', this.failure);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.prepend(this.renderer.domElement);
    // the graphics driver can drop the context mid-session (GPU reset, sleep): say so, and pick up again when it's back
    this.renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); this.failure = 'The graphics driver reset the 3D view (this can happen after sleep or a GPU crash).'; this.onFailure(this.failure); });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => { this.failure = null; this.onFailure(null); });
    this.camera.position.set(7.5, 4.2, 23);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 400;
    this.studio(!!renderer);

    // post-processing: multisampled render → GTAO → bloom → tone map / sRGB
    if (renderer) {
      try {
        const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
        this.gtao.output = GTAOPass.OUTPUT.Default;
        this.gtao.blendIntensity = 0.85;
        this.composer.addPass(this.gtao);
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.4, 1.6); // only emissive LEDs / lit screens bloom
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      } catch (e) { console.warn('[formframe] post-processing unavailable, drawing plainly', e); this.composer = null; }
    }

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    let lastRender = 0;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // While firmware is emulating, render at ≤30 fps (≤15 in Fast) to leave CPU for the emulator.
      if (this.throttle && now - lastRender < (this.quality === 'high' ? 32 : 66)) return;
      lastRender = now;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      this.controls.update();
      for (const t of this.tickers) t(dt, now);
      if (this.paused) return;
      if (this.failure) return; // the simulation above keeps ticking; there's just nothing to draw on
      if (now - this.shadowT > 400) { this.shadowT = now; this.castShadows(); }
      try { this.render(); } catch (e: any) { this.failure = `Drawing the 3D view failed: ${e?.message ?? e}`; console.warn('[formframe]', this.failure, e); this.onFailure(this.failure); }
    };
    requestAnimationFrame(loop);
  }

  render() {
    // Fast is the low-power mode: no shadow pass, no post-processing, 1x pixels
    const high = this.quality === 'high';
    if (this.key.castShadow !== high) this.key.castShadow = high;
    const pr = high ? Math.min(devicePixelRatio, 2) : 1;
    if (this.renderer.getPixelRatio() !== pr) { this.renderer.setPixelRatio(pr); this.resize(); }
    if (this.quality === 'high' && !this.throttle && this.composer) this.composer.render();
    else { this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.render(this.scene, this.camera); }
  }

  private studio(gl: boolean) {
    // backdrop: a soft studio gradient (post-processing makes the canvas opaque, so the scene paints its own)
    const bg = document.createElement('canvas'); bg.width = 4; bg.height = 256;
    const bgc = bg.getContext('2d')!, bgg = bgc.createLinearGradient(0, 0, 0, 256);
    bgg.addColorStop(0, '#f4f6f9'); bgg.addColorStop(0.6, '#e6e9ee'); bgg.addColorStop(1, '#d9dde3');
    bgc.fillStyle = bgg; bgc.fillRect(0, 0, 4, 256);
    const bgt = new THREE.CanvasTexture(bg); bgt.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bgt;
    // image-based lighting: a studio room with softboxes (three's RoomEnvironment), slightly warm
    if (gl) { const pm = new THREE.PMREMGenerator(this.renderer); this.scene.environment = pm.fromScene(new RoomEnvironment(this.renderer), 0.03).texture; }
    (this.scene as any).environmentIntensity = 0.75;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a30, 0.25));
    const key = (this.key = new THREE.DirectionalLight(0xfff4e8, 1.7));
    key.position.set(6, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xc8d6ff, 0.7); rim.position.set(-8, 4, -7); this.scene.add(rim);
    // floor: a shadow catcher (only shadows show) + a soft contact shadow right under the model
    const ground = (this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ color: 0x1a2030, opacity: 0.2 })));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.name = '__ground'; ground.userData.noShadowCast = true;
    this.scene.add(ground);
    const g = document.createElement('canvas'); g.width = g.height = 128;
    const c = g.getContext('2d')!, grad = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.45)'); grad.addColorStop(0.55, 'rgba(0,0,0,0.18)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad; c.fillRect(0, 0, 128, 128);
    const contact = (this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(g), transparent: true, depthWrite: false, toneMapped: false })));
    contact.rotation.x = -Math.PI / 2; contact.userData.noShadowCast = true; contact.renderOrder = -1;
    this.scene.add(contact);
    this.placeFloor(new THREE.Box3(new THREE.Vector3(-4, -5, -2), new THREE.Vector3(4, 5, 2)));
  }

  /** Meshes cast and receive shadows (except overlays and things that opt out). */
  private castShadows() {
    this.scene.traverse((o: any) => {
      if (!o.isMesh || o.userData.noShadowCast) return;
      // nothing inside editing gizmos / helpers casts or catches shadows
      for (let q = o.parent; q; q = q.parent) if (q.isTransformControls || q.type === 'TransformControls' || q.userData?.noShadowCast) { o.castShadow = o.receiveShadow = false; return; }
      const m = o.material, overlay = m && (m.depthTest === false || m.transparent && m.opacity < 0.3 || o.parent?.type === 'TransformControlsGizmo' || o.type === 'Line');
      o.castShadow = !overlay; o.receiveShadow = !overlay;
    });
  }

  /** Put the floor under a bounding box and fit the shadow camera around it. */
  private placeFloor(box: THREE.Box3) {
    const s = box.getBoundingSphere(new THREE.Sphere()), r = Math.max(1, s.radius);
    this.ground.position.set(s.center.x, box.min.y - 0.02, s.center.z); this.ground.scale.setScalar(r * 12);
    const size = box.getSize(new THREE.Vector3());
    this.contact.position.set(s.center.x, box.min.y - 0.01, s.center.z); this.contact.scale.set(size.x * 1.5 + 0.5, size.z * 1.5 + 0.5, 1);
    const k = this.key, cam = k.shadow.camera;
    k.target.position.copy(s.center); k.position.copy(s.center).add(new THREE.Vector3(0.45, 1, 0.6).normalize().multiplyScalar(r * 4));
    cam.left = -r * 1.6; cam.right = r * 1.6; cam.top = r * 1.6; cam.bottom = -r * 1.6; cam.near = r * 0.5; cam.far = r * 9;
    cam.updateProjectionMatrix(); k.shadow.needsUpdate = true;
  }

  resize() {
    const r = this.el.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    const c = this.renderer.domElement; c.style.width = w + 'px'; c.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.composer?.setPixelRatio(pr); this.composer?.setSize(w, h);
  }

  onTick(fn: (dt: number, now: number) => void) { this.tickers.push(fn); }

  hit(e: { clientX: number; clientY: number }, objects: THREE.Object3D[]) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(p, this.camera);
    return this.ray.intersectObjects(objects, false)[0] ?? null;
  }

  project(v: THREE.Vector3) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * r.width + r.left, y: ((-p.y + 1) / 2) * r.height + r.top, behind: p.z > 1 };
  }

  /** Frame an object: fit its bounding sphere in view, and move the floor and shadows under it. */
  frame(obj: THREE.Object3D, extra: THREE.Vector3[] = []) {
    const box = new THREE.Box3();
    obj.updateWorldMatrix(true, true);
    obj.traverseVisible(o => { if ((o as any).isMesh && !o.userData.world) box.expandByObject(o); });
    for (const p of extra) box.expandByPoint(p);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(8, 8, 3)); // blank project: default framing
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.placeFloor(box);
    const dist = s.radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
    const dir = new THREE.Vector3(0.45, 0.32, 1).normalize();
    this.controls.target.copy(s.center);
    this.camera.position.copy(s.center).addScaledVector(dir, dist);
    this.camera.near = dist / 100; this.camera.far = dist * 40; this.camera.updateProjectionMatrix();
  }
  /** Re-fit the floor and shadow camera to an object without moving the camera (models that move, worlds). */
  refit(obj: THREE.Object3D) {
    const box = new THREE.Box3();
    obj.updateWorldMatrix(true, true);
    obj.traverseVisible(o => { if ((o as any).isMesh && !o.userData.world) box.expandByObject(o); });
    if (!box.isEmpty()) this.placeFloor(box);
  }
  /** The floor shows when there is no world of its own. */
  showFloor(on: boolean) { this.ground.visible = on; this.contact.visible = on; }

  snapshot(type = 'image/png') { return this.renderer.domElement.toDataURL(type); }
}
