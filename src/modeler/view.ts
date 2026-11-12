import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { BuiltProduct } from '../scene/built';

/**
 * The modeler's 3D viewport, Blender conventions: Z up, millimetres, front
 * view looks along +Y. Product data is Y-up with the front facing +Z, so the
 * model sits under `world`, rotated +90° about X: ours (x, y, z) → (x, −z, y).
 */
export type Shading = 'wire' | 'solid' | 'material' | 'rendered';
export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';
export const AXIS_COL = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff };
const VIEW_DIR: Record<ViewName, [number, number, number]> = { front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1] };
const VIEW_LABEL: Record<ViewName, string> = { front: 'Front', back: 'Back', right: 'Right', left: 'Left', top: 'Top', bottom: 'Bottom' };

function gridMaterial(axes: [number, number], c0: number, c1: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, extensions: { derivatives: true } as any,
    uniforms: { uD: { value: 200 }, uCam: { value: new THREE.Vector3() }, uC0: { value: new THREE.Color(c0) }, uC1: { value: new THREE.Color(c1) }, uA: { value: new THREE.Vector2(...axes) } },
    vertexShader: `varying vec3 vP; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uD; uniform vec3 uCam; uniform vec3 uC0; uniform vec3 uC1; uniform vec2 uA; varying vec3 vP;
      float pick(vec3 v, float i){ return i < 0.5 ? v.x : (i < 1.5 ? v.y : v.z); }
      float gl(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        vec2 p = vec2(pick(vP, uA.x), pick(vP, uA.y));
        vec2 c = vec2(pick(uCam, uA.x), pick(uCam, uA.y));
        float lvl = log(max(uD * 0.12, 1.0)) / log(10.0), s = pow(10.0, floor(lvl)), t = fract(lvl);
        float a = max(gl(p, s) * 0.28 * (1.0 - t), gl(p, s * 10.0) * 0.42);
        vec3 col = vec3(0.30);
        float l0 = 1.0 - min(abs(p.y) / fwidth(p.y) / 1.2, 1.0), l1 = 1.0 - min(abs(p.x) / fwidth(p.x) / 1.2, 1.0);
        if (l0 > 0.02) { col = uC0; a = max(a, l0 * 0.85); }
        if (l1 > 0.02) { col = uC1; a = max(a, l1 * 0.85); }
        float d = length(p - c);
        a *= 1.0 - smoothstep(uD * 1.5, uD * 6.0, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
      }`,
  });
}

function cursorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!;
  g.lineWidth = 3;
  for (let i = 0; i < 8; i++) { g.strokeStyle = i % 2 ? '#ffffff' : '#ff3030'; g.beginPath(); g.arc(32, 32, 14, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2); g.stroke(); }
  g.strokeStyle = '#000'; g.lineWidth = 1.5;
  for (const [x0, y0, x1, y1] of [[32, 2, 32, 14], [32, 50, 32, 62], [2, 32, 14, 32], [50, 32, 62, 32]]) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  world = new THREE.Group();
  persp = new THREE.PerspectiveCamera(39.6, 1, 0.5, 20000);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  controls: OrbitControls;
  tc: TransformControls;
  helper = new THREE.Object3D();
  cursor = new THREE.Vector3();
  shading: Shading = 'solid';
  xray = false;
  overlays = true;
  aligned: ViewName | null = null;
  private alignDir = new THREE.Vector3();
  private autoOrtho = false;
  private composer: EffectComposer;
  private rp: RenderPass;
  private outSel: OutlinePass;
  private outAct: OutlinePass;
  private grids: Record<'xy' | 'xz' | 'yz', THREE.Mesh>;
  private cursorSprite: THREE.Sprite;
  private wireMat = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true });
  private matCache = new Map<THREE.Material, THREE.Material>();
  private xrayCache = new Map<THREE.Material, THREE.Material>();
  private shadowCatcher: THREE.Mesh;
  private key!: THREE.DirectionalLight;
  axisLine: THREE.Line;
  prod: BuiltProduct | null = null;
  nav: HTMLCanvasElement;
  onChange: () => void = () => {};
  private navHover = -1;

  constructor(public el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.prepend(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x3d3d3d);
    this.world.rotation.x = Math.PI / 2;
    this.scene.add(this.world);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.persp.position.set(160, -220, 120);
    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.enableZoom = false; this.controls.enableDamping = false; this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: -1 as any, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as any };
    this.controls.rotateSpeed = 0.9;
    this.controls.addEventListener('change', () => this.onChange());
    this.studio();

    // grids for the floor and for side orthographic views
    const plane = new THREE.PlaneGeometry(1, 1);
    this.grids = {
      xy: new THREE.Mesh(plane, gridMaterial([0, 1], AXIS_COL.x, AXIS_COL.y)),
      xz: new THREE.Mesh(plane, gridMaterial([0, 2], AXIS_COL.x, AXIS_COL.z)),
      yz: new THREE.Mesh(plane, gridMaterial([1, 2], AXIS_COL.y, AXIS_COL.z)),
    };
    this.grids.xz.rotation.x = Math.PI / 2; this.grids.yz.rotation.y = Math.PI / 2;
    for (const g of Object.values(this.grids)) { g.scale.setScalar(40000); g.renderOrder = -1; g.userData.overlay = true; this.scene.add(g); }

    this.cursorSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: cursorTexture(), depthTest: false, sizeAttenuation: false }));
    this.cursorSprite.scale.setScalar(0.05); this.cursorSprite.renderOrder = 999; this.cursorSprite.userData.overlay = true;
    this.scene.add(this.cursorSprite);

    this.axisLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1e4, 0, 0), new THREE.Vector3(1e4, 0, 0)]), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.axisLine.visible = false; this.axisLine.renderOrder = 998; this.scene.add(this.axisLine);

    const sm = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), sm); this.shadowCatcher.receiveShadow = true; this.shadowCatcher.visible = false; this.scene.add(this.shadowCatcher);

    this.scene.add(this.helper);
    this.tc = new TransformControls(this.persp, this.renderer.domElement);
    this.tc.setSize(0.9); this.tc.attach(this.helper); this.tc.visible = false; (this.tc as any).enabled = false;
    this.tc.addEventListener('dragging-changed', (e: any) => { this.controls.enabled = !e.value; });
    this.scene.add(this.tc);

    this.composer = new EffectComposer(this.renderer);
    this.rp = new RenderPass(this.scene, this.cam);
    this.outSel = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.cam);
    this.outAct = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.cam);
    for (const [o, c] of [[this.outSel, 0xf15800], [this.outAct, 0xffaa40]] as const) {
      o.visibleEdgeColor.set(c); o.hiddenEdgeColor.set(c).multiplyScalar(0.35); o.edgeStrength = 6; o.edgeThickness = 1; o.edgeGlow = 0; o.pulsePeriod = 0;
    }
    this.composer.addPass(this.rp); this.composer.addPass(this.outSel); this.composer.addPass(this.outAct); this.composer.addPass(new OutputPass());

    this.nav = el.querySelector('#navGizmo') as HTMLCanvasElement;
    this.wireNav();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); this.render(); };
    requestAnimationFrame(loop);
  }

  private studio() {
    const pm = new THREE.PMREMGenerator(this.renderer), es = new THREE.Scene();
    es.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: 0x2a2a2e, side: THREE.BackSide })));
    const panel = (w: number, hh: number, x: number, y: number, z: number, ry: number, rx: number, c: number) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); es.add(m); };
    panel(14, 6, 0, 13, 0, 0, Math.PI / 2, 0xffffff); panel(6, 10, -13, 2, 2, Math.PI / 2, 0, 0xcfd8ff); panel(5, 8, 13, 0, -2, -Math.PI / 2, 0, 0xffe6cc); panel(10, 4, 0, 2, 14, 0, 0, 0x888888);
    this.scene.environment = pm.fromScene(es, 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303034, 0.5));
    this.key = new THREE.DirectionalLight(0xffffff, 1.4); this.key.position.set(300, -400, 600); this.scene.add(this.key);
    this.key.shadow.mapSize.set(2048, 2048);
    const rim = new THREE.DirectionalLight(0xbfd0ff, 0.5); rim.position.set(-400, 300, 200); this.scene.add(rim);
  }

  setProduct(p: BuiltProduct) {
    if (this.prod) this.world.remove(this.prod.mm);
    this.prod = p; p.mm.scale.setScalar(1); this.world.add(p.mm);
    this.refreshMaterials();
  }

  /** Swap materials for the shading mode and X-ray; call after every rebuild. */
  refreshMaterials() {
    for (const m of [...this.matCache.values(), ...this.xrayCache.values()]) m.dispose();
    this.matCache.clear(); this.xrayCache.clear();
    if (!this.prod) return;
    const rendered = this.shading === 'rendered';
    this.prod.mm.traverse((o: any) => {
      if (!o.isMesh) return;
      const orig: THREE.Material = o.userData.orig ?? (o.userData.orig = o.material);
      let m = orig;
      if (this.shading === 'solid') {
        m = this.matCache.get(orig) ?? (() => {
          const src: any = orig, col = src.map ? new THREE.Color(0x202226) : src.color?.clone() ?? new THREE.Color(0xcccccc);
          const s = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0, envMapIntensity: 0.55, side: THREE.DoubleSide, transparent: src.transparent, opacity: src.opacity });
          this.matCache.set(orig, s); return s;
        })();
      }
      if (this.xray && this.shading !== 'wire') {
        const base = m;
        m = this.xrayCache.get(base) ?? (() => { const x = base.clone(); x.transparent = true; x.opacity = Math.min(x.opacity, 0.35); x.depthWrite = false; this.xrayCache.set(base, x); return x; })();
      }
      o.material = m;
      o.castShadow = rendered; o.receiveShadow = false;
    });
    this.renderer.shadowMap.enabled = rendered;
    this.key.castShadow = rendered;
    this.shadowCatcher.visible = rendered;
    if (rendered) this.fitShadow();
  }
  private fitShadow() {
    const b = new THREE.Box3().setFromObject(this.world);
    if (b.isEmpty()) return;
    const s = b.getBoundingSphere(new THREE.Sphere());
    this.shadowCatcher.position.set(s.center.x, s.center.y, b.min.z - 0.05);
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -s.radius * 1.5; sc.right = sc.top = s.radius * 1.5; sc.near = 1; sc.far = 4000; sc.updateProjectionMatrix();
    this.key.target.position.copy(s.center); this.key.position.copy(s.center).add(new THREE.Vector3(300, -400, 600)); this.scene.add(this.key.target);
  }

  setSelection(sel: THREE.Object3D[], active: THREE.Object3D | null) {
    const meshes = (os: THREE.Object3D[]) => { const out: THREE.Object3D[] = []; os.forEach(o => o.traverse(c => { if ((c as any).isMesh) out.push(c); })); return out; };
    this.outSel.selectedObjects = meshes(sel.filter(o => o !== active));
    this.outAct.selectedObjects = active ? meshes([active]) : [];
  }

  // ---------------------------------------------------------------- camera
  get target() { return this.controls.target; }
  resize() {
    const r = this.el.getBoundingClientRect(), w = Math.max(1, r.width), hh = Math.max(1, r.height);
    this.renderer.setSize(w, hh, false);
    const c = this.renderer.domElement; c.style.width = w + 'px'; c.style.height = hh + 'px';
    this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, hh);
    this.persp.aspect = w / hh; this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }
  private updateOrthoFrustum() {
    const r = this.el.getBoundingClientRect(), a = Math.max(1, r.width) / Math.max(1, r.height);
    const d = this.persp.position.distanceTo(this.target), hh = d * Math.tan((this.persp.fov * Math.PI) / 360);
    Object.assign(this.ortho, { left: -hh * a, right: hh * a, top: hh, bottom: -hh, zoom: 1 });
    this.ortho.updateProjectionMatrix();
  }
  get isOrtho() { return this.cam === this.ortho; }
  setOrtho(on: boolean) {
    if (on === this.isOrtho) return;
    if (on) { this.updateOrthoFrustum(); this.ortho.position.copy(this.persp.position); this.ortho.quaternion.copy(this.persp.quaternion); this.cam = this.ortho; }
    else { // keep apparent size: put the perspective camera at the matching distance
      const d = this.persp.position.distanceTo(this.target) / this.ortho.zoom, dir = this.ortho.position.clone().sub(this.target).normalize();
      this.persp.position.copy(this.target).addScaledVector(dir, d); this.cam = this.persp; this.updateOrthoFrustum();
    }
    this.controls.object = this.cam; (this.tc as any).camera = this.cam;
    this.rp.camera = this.cam; (this.outSel as any).renderCamera = this.cam; (this.outAct as any).renderCamera = this.cam;
    this.controls.update(); this.onChange();
  }
  /** Distance used for zoom-dependent things (grid level, pan speed). */
  viewDist() { return this.isOrtho ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / (2 * Math.tan((this.persp.fov * Math.PI) / 360)) : this.cam.position.distanceTo(this.target); }

  dolly(f: number) {
    if (this.isOrtho) { this.ortho.zoom = Math.min(200, Math.max(0.01, this.ortho.zoom / f)); this.ortho.updateProjectionMatrix(); }
    const off = this.cam.position.clone().sub(this.target).multiplyScalar(f);
    if (off.length() < 1) off.setLength(1);
    this.cam.position.copy(this.target).add(off);
    if (this.isOrtho) this.persp.position.copy(this.cam.position);
    this.controls.update(); this.onChange();
  }
  pan(dx: number, dy: number) {
    const r = this.el.getBoundingClientRect(), k = (2 * this.viewDist() * Math.tan((this.persp.fov * Math.PI) / 360)) / r.height;
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 1);
    const mv = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
    this.cam.position.add(mv); this.target.add(mv); if (this.isOrtho) this.persp.position.add(mv);
    this.controls.update(); this.onChange();
  }
  /** Turntable orbit (radians), like Blender: azimuth about world Z, then elevation. */
  orbit(dAz: number, dEl: number) {
    const off = this.cam.position.clone().sub(this.target);
    off.applyAxisAngle(new THREE.Vector3(0, 0, 1), dAz);
    const right = new THREE.Vector3(0, 0, 1).cross(off).normalize();
    const next = off.clone().applyAxisAngle(right, dEl);
    if (Math.abs(next.clone().normalize().z) < 0.999) off.copy(next);
    this.cam.position.copy(this.target).add(off); this.cam.lookAt(this.target);
    if (this.isOrtho) this.persp.position.copy(this.cam.position);
    this.controls.update(); this.onChange();
  }
  setView(v: ViewName, opposite = false) {
    if (opposite) v = ({ front: 'back', back: 'front', right: 'left', left: 'right', top: 'bottom', bottom: 'top' } as const)[v];
    const d = this.viewDist(), dir = new THREE.Vector3(...VIEW_DIR[v]);
    if (!this.isOrtho) { this.setOrtho(true); this.autoOrtho = true; }
    this.cam.up.set(0, 0, 1);
    if (v === 'top') this.cam.up.set(0, 1, 0); if (v === 'bottom') this.cam.up.set(0, -1, 0);
    this.cam.position.copy(this.target).addScaledVector(dir, d); this.persp.position.copy(this.cam.position);
    this.cam.lookAt(this.target);
    this.aligned = v; this.alignDir.copy(dir);
    this.controls.update(); this.onChange();
  }
  private checkAlign() {
    if (!this.aligned) return;
    const dir = this.cam.position.clone().sub(this.target).normalize();
    if (dir.dot(this.alignDir) < 0.9999) {
      this.aligned = null; this.cam.up.set(0, 0, 1); this.persp.up.set(0, 0, 1);
      if (this.autoOrtho) { this.autoOrtho = false; this.setOrtho(false); }
      this.onChange();
    }
  }
  viewLabel() { return `${this.aligned ? VIEW_LABEL[this.aligned] : 'User'} ${this.isOrtho ? 'Orthographic' : 'Perspective'}`; }

  /** Frame objects (or everything) like Home / Numpad-period. */
  frame(objs?: THREE.Object3D[]) {
    const b = new THREE.Box3();
    (objs?.length ? objs : [this.world]).forEach(o => b.expandByObject(o));
    if (b.isEmpty()) b.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(100, 100, 100));
    const s = b.getBoundingSphere(new THREE.Sphere()), dist = Math.max(20, s.radius / Math.sin((this.persp.fov * Math.PI) / 360) * 1.15);
    const dir = this.cam.position.clone().sub(this.target).normalize();
    this.target.copy(s.center);
    this.cam.position.copy(s.center).addScaledVector(dir, dist); this.persp.position.copy(this.cam.position);
    if (this.isOrtho) { this.ortho.zoom = 1; this.updateOrthoFrustum(); }
    this.controls.update(); this.onChange();
  }

  // ---------------------------------------------------------------- picking
  private ray = new THREE.Raycaster();
  ndc(x: number, y: number) { const r = this.renderer.domElement.getBoundingClientRect(); return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); }
  pick(x: number, y: number, objs: THREE.Object3D[]) { this.ray.setFromCamera(this.ndc(x, y), this.cam); return this.ray.intersectObjects(objs, false)[0] ?? null; }
  rayPlane(x: number, y: number, point: THREE.Vector3, normal: THREE.Vector3) {
    this.ray.setFromCamera(this.ndc(x, y), this.cam);
    return this.ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point), new THREE.Vector3());
  }
  viewNormal() { return this.cam.getWorldDirection(new THREE.Vector3()).negate(); }
  project(v: THREE.Vector3) {
    const r = this.renderer.domElement.getBoundingClientRect(), p = v.clone().project(this.cam);
    return { x: ((p.x + 1) / 2) * r.width + r.left, y: ((-p.y + 1) / 2) * r.height + r.top, behind: p.z > 1 };
  }

  // ---------------------------------------------------------------- render
  render() {
    this.checkAlign();
    const d = this.viewDist();
    const side = this.isOrtho && this.aligned ? ({ front: 'xz', back: 'xz', right: 'yz', left: 'yz', top: 'xy', bottom: 'xy' } as const)[this.aligned] : 'xy';
    for (const [k, g] of Object.entries(this.grids)) {
      g.visible = this.overlays && k === side;
      const u = (g.material as THREE.ShaderMaterial).uniforms; u.uD.value = d; u.uCam.value.copy(this.target);
    }
    this.cursorSprite.position.copy(this.cursor); this.cursorSprite.visible = this.overlays;
    this.scene.overrideMaterial = null;
    const wire = this.shading === 'wire';
    if (wire && this.prod) this.prod.mm.traverse((o: any) => { if (o.isMesh) { o.userData.keep = o.material; o.material = this.wireMat; } });
    this.composer.render();
    if (wire && this.prod) this.prod.mm.traverse((o: any) => { if (o.isMesh && o.userData.keep) { o.material = o.userData.keep; delete o.userData.keep; } });
    this.drawNav();
  }
  snapshot() {
    const ov = this.overlays, sel = this.outSel.selectedObjects, act = this.outAct.selectedObjects;
    this.overlays = false; this.outSel.selectedObjects = []; this.outAct.selectedObjects = []; const tcv = this.tc.visible; this.tc.visible = false;
    this.render(); const url = this.renderer.domElement.toDataURL('image/png');
    this.overlays = ov; this.outSel.selectedObjects = sel; this.outAct.selectedObjects = act; this.tc.visible = tcv;
    return url;
  }

  // ---------------------------------------------------------------- navigation gizmo
  private navAxes() {
    const q = this.cam.quaternion.clone().invert(), R = 30, C = 40;
    return ([['x', 1, 0, 0], ['y', 0, 1, 0], ['z', 0, 0, 1], ['-x', -1, 0, 0], ['-y', 0, -1, 0], ['-z', 0, 0, -1]] as const).map(([n, x, y, z], i) => {
      const v = new THREE.Vector3(x, y, z).applyQuaternion(q);
      return { n, i, pos: n[0] !== '-', col: AXIS_COL[n.replace('-', '') as 'x'], sx: C + v.x * R, sy: C - v.y * R, z: v.z };
    });
  }
  private drawNav() {
    const c = this.nav, g = c.getContext('2d')!, dpr = devicePixelRatio;
    if (c.width !== 80 * dpr) { c.width = c.height = 80 * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, 80, 80);
    if (this.navHover === -2) { g.fillStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.arc(40, 40, 39, 0, Math.PI * 2); g.fill(); }
    const ax = this.navAxes().sort((a, b) => a.z - b.z);
    const hex = (n: number, a = 1) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    for (const a of ax) {
      if (a.pos) { g.strokeStyle = hex(a.col); g.lineWidth = 2; g.beginPath(); g.moveTo(40, 40); g.lineTo(a.sx, a.sy); g.stroke(); }
      g.beginPath(); g.arc(a.sx, a.sy, a.pos ? 8 : 7, 0, Math.PI * 2);
      g.fillStyle = a.pos ? hex(a.col) : hex(a.col, this.navHover === a.i ? 0.7 : 0.3); g.fill();
      if (!a.pos) { g.strokeStyle = hex(a.col, 0.9); g.lineWidth = 1.2; g.stroke(); }
      if (this.navHover === a.i) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      if (a.pos || this.navHover === a.i) { g.fillStyle = a.pos ? '#161616' : '#fff'; g.font = '600 10px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(a.n.replace('-', a.pos ? '' : '-').toUpperCase(), a.sx, a.sy + 0.5); }
    }
  }
  private wireNav() {
    const c = this.nav;
    const hit = (e: PointerEvent) => { const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; let best = -1, bz = -9; for (const a of this.navAxes()) if (Math.hypot(a.sx - x, a.sy - y) < 9 && a.z > bz) { best = a.i; bz = a.z; } return best >= 0 ? best : Math.hypot(x - 40, y - 40) < 40 ? -2 : -1; };
    let drag: { x: number; y: number; moved: boolean } | null = null;
    c.onpointermove = e => {
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true; if (drag.moved) { this.orbit(-dx * 0.012, -dy * 0.012); drag.x = e.clientX; drag.y = e.clientY; } return; }
      this.navHover = hit(e);
    };
    c.onpointerleave = () => { if (!drag) this.navHover = -1; };
    c.onpointerdown = e => { e.stopPropagation(); c.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false }; };
    c.onpointerup = e => {
      const d = drag; drag = null; if (!d || d.moved) return;
      const i = hit(e); if (i < 0) return;
      const map: ViewName[] = ['right', 'back', 'top', 'left', 'front', 'bottom'];
      this.setView(map[i]);
    };
  }
}
