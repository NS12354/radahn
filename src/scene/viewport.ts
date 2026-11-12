import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Renderer, camera, studio lighting and picking. */
export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  controls: OrbitControls;
  private ray = new THREE.Raycaster();
  private tickers: ((dt: number, now: number) => void)[] = [];
  private last = performance.now();
  /** Set by the electronics panel while an emulator runs. */
  throttle = false;

  constructor(public el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    el.prepend(this.renderer.domElement);
    this.camera.position.set(7.5, 4.2, 23);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 80;
    this.studio();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    let lastRender = 0;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // While firmware is emulating, render at ≤30 fps to leave CPU for the emulator.
      if (this.throttle && now - lastRender < 32) return;
      lastRender = now;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      this.controls.update();
      for (const t of this.tickers) t(dt, now);
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  private studio() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const es = new THREE.Scene();
    es.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: 0x2a2a2e, side: THREE.BackSide })));
    const panel = (w: number, h: number, x: number, y: number, z: number, ry: number, rx: number, c: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0); es.add(m);
    };
    panel(14, 6, 0, 13, 0, 0, Math.PI / 2, 0xffffff); panel(6, 10, -13, 2, 2, Math.PI / 2, 0, 0xcfd8ff);
    panel(5, 8, 13, 0, -2, -Math.PI / 2, 0, 0xffe6cc); panel(10, 4, 0, 2, 14, 0, 0, 0x888888);
    this.scene.environment = pm.fromScene(es, 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x222226, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(5, 8, 9); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd0ff, 0.5); rim.position.set(-8, 3, -6); this.scene.add(rim);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.18 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -5.4; ground.name = '__ground'; this.scene.add(ground);
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    const c = this.renderer.domElement; c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
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

  /** Frame an object: fit its bounding sphere in view. */
  frame(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(8, 8, 3)); // blank project: default framing
    const s = box.getBoundingSphere(new THREE.Sphere());
    const ground = this.scene.getObjectByName('__ground');
    if (ground && !box.isEmpty()) { ground.position.y = box.min.y - 0.3; ground.scale.setScalar(Math.max(1, s.radius / 6)); }
    const dist = s.radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
    const dir = new THREE.Vector3(0.3, 0.18, 1).normalize();
    this.controls.target.copy(s.center);
    this.camera.position.copy(s.center).addScaledVector(dir, dist);
    this.camera.near = dist / 100; this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
  }

  snapshot(type = 'image/png') { return this.renderer.domElement.toDataURL(type); }
}
