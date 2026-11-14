import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Product, type Role } from './product';
import { FINISHES } from './parametric';
import type { BuiltModel, BuiltPart } from '../app/project';
import { instances } from '../app/fit';
import { partMeshGeometry } from './mesh';
import { screenPart, type ScreenPick } from '../app/screenpart';

/**
 * A product made of primitives (by hand in the modeler, or by auto build).
 * Parts are authored in millimetres inside `mm`, a group scaled to scene units
 * (1 unit = 10 mm, same as the parametric model). Each part is a root group at
 * its pos/rot; array copies are children. Roles work like an imported model:
 * dial parts spin together about the first dial part's axis, press/screen
 * parts sink when pressed, LED parts light up (one material per segment).
 */
const D2R = Math.PI / 180;
export const CLEAR = { r: 0.05, m: 0, cc: 1 };

function annulus(ro: number, ri: number, a0 = 0, a1 = Math.PI * 2) {
  const s = new THREE.Shape(), full = a1 - a0 >= Math.PI * 2 - 1e-6, seg = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
  if (full) {
    s.absarc(0, 0, ro, 0, Math.PI * 2, false);
    if (ri > 0) { const h = new THREE.Path(); h.absarc(0, 0, ri, 0, Math.PI * 2, true); s.holes.push(h); }
  } else {
    s.moveTo(Math.cos(a0) * ro, Math.sin(a0) * ro);
    s.absarc(0, 0, ro, a0, a1, false);
    s.lineTo(Math.cos(a1) * ri, Math.sin(a1) * ri);
    s.absarc(0, 0, ri, a1, a0, true);
  }
  return { s, seg };
}

/** Geometry for one shape (or one LED segment of it), in mm, centred on the origin, front = +Z. */
export function shapeGeometry(p: BuiltPart, segment?: { i: number; n: number }): THREE.BufferGeometry {
  const [w, h, d] = p.size.map(v => Math.max(0.01, v));
  let g: THREE.BufferGeometry;
  if (p.shape === 'mesh') return partMeshGeometry(p);
  switch (p.shape) {
    case 'box': g = new THREE.BoxGeometry(w, h, d); break;
    case 'rbox': {
      const r = Math.max(0.01, Math.min(p.param ?? 2, Math.min(w, h, d) / 2 - 0.01));
      g = new RoundedBoxGeometry(w, h, d, 4, r); break;
    }
    case 'cyl': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 72).rotateX(Math.PI / 2).scale(w, h, d); break;
    case 'cone': g = new THREE.CylinderGeometry(0.5 * Math.max(0, Math.min(1, p.param ?? 0.6)), 0.5, 1, 72).rotateX(Math.PI / 2).scale(w, h, d); break;
    case 'sphere': g = new THREE.SphereGeometry(0.5, 48, 24).scale(w, h, d); break;
    case 'disc': g = new THREE.CircleGeometry(0.5, 72).scale(w, h, 1).translate(0, 0, d / 2); break;
    case 'rect': g = new THREE.PlaneGeometry(w, h).translate(0, 0, d / 2); break;
    case 'torus': {
      const tube = Math.min(d, w / 2) / 2, R = w / 2 - tube;
      if (segment) {
        const arc = (Math.PI * 2) / segment.n;
        g = new THREE.TorusGeometry(R, tube, 12, 12, arc * 0.92).rotateZ(Math.PI / 2 - arc * (segment.i + 1) + arc * 0.04);
      } else g = new THREE.TorusGeometry(R, tube, 16, 96);
      g.scale(1, h / w, 1); break;
    }
    case 'tube': default: {
      const ro = 0.5, ri = Math.max(0, Math.min(0.495, (p.param ?? w * 0.8) / w / 2));
      let a0 = 0, a1 = Math.PI * 2;
      if (segment) { const arc = (Math.PI * 2) / segment.n; a1 = Math.PI / 2 - arc * segment.i - arc * 0.04; a0 = a1 - arc * 0.92; }
      const { s, seg } = annulus(ro, ri, a0, a1);
      g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: seg }).translate(0, 0, -0.5).scale(w, h, d); break;
    }
  }
  return g;
}

function material(p: BuiltPart) {
  const f = p.finish === 'clear' ? CLEAR : FINISHES[p.finish] ?? FINISHES.matte;
  const m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(p.color), roughness: f.r, metalness: f.m, clearcoat: f.cc ?? 0, clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  if (p.finish === 'clear') { m.transparent = true; m.opacity = 0.5; }
  return m;
}

interface RootData { part: BuiltPart; base: THREE.Vector3; baseQ: THREE.Quaternion }

/** The display as a panel on a solid part's front face (local +Z), slightly proud of it. */
function frontPanel(p: BuiltPart): THREE.BufferGeometry {
  const [w, h, d] = p.size;
  const round = ['cyl', 'cone', 'sphere', 'torus', 'tube'].includes(p.shape);
  const zOff = p.shape === 'sphere' ? d / 2 * 0.98 : d / 2 + 0.05;
  if (round) { const r = p.shape === 'tube' && p.param ? Math.min(p.param, Math.min(w, h)) / Math.min(w, h) : 0.94; return new THREE.CircleGeometry(0.5 * r, 96).scale(w, h, 1).translate(0, 0, zOff); }
  const inset = p.shape === 'rbox' ? Math.max(0.6, 1 - 2 * (p.param ?? 0) / Math.min(w, h)) : 0.94;
  return new THREE.PlaneGeometry(w * inset, h * inset).translate(0, 0, zOff);
}

export class BuiltProduct extends Product {
  /** Millimetre space: everything the modeler edits lives in here. */
  mm = new THREE.Group();
  roots = new Map<string, THREE.Group>();
  private screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
  private ledMats: THREE.MeshStandardMaterial[] = [];
  private ownMats: THREE.Material[] = [];
  private sel: string | null = null;
  private explodeT = 0;
  private explodeGoal = 0;
  private pressDepth = 0;
  /** The part showing the display (Screen role, or picked automatically by name). */
  screenOn: ScreenPick | null = null;
  /** Exploded view: mm per layer step, from the model's depth. */
  private explStep = 8;
  private faded = -1;
  private pivot = { c: new THREE.Vector3(), axis: new THREE.Vector3(0, 0, 1), on: false };
  /** Root the modeler is dragging: left alone by the per-frame transform pass. */
  frozen: THREE.Object3D | null = null;

  constructor(public model: BuiltModel, private displays: string[] = []) {
    super();
    this.mm.scale.setScalar(0.1);
    this.group.add(this.mm);
    this.build();
  }

  /** The wired display components (their model part shows the screen). Rebuilds if they changed. */
  setDisplays(uids: string[]) {
    if (uids.join() === this.displays.join()) return;
    this.displays = uids; this.build();
  }

  /** Rebuild every part's meshes from the model. */
  build() {
    this.clearParts();
    this.screenOn = screenPart(this.model.parts, this.displays);
    const dial = this.model.parts.filter(p => p.role === 'dial');
    this.pivot.on = dial.length > 0;
    if (dial[0]) {
      this.pivot.c.set(...dial[0].pos);
      this.pivot.axis.set(0, 0, 1).applyEuler(new THREE.Euler(...dial[0].rot.map(v => v * D2R) as [number, number, number]));
    }
    for (const p of this.model.parts) this.mm.add(this.buildPart(p));
    const zs = this.model.parts.flatMap(p => [p.pos[2] - p.size[2] / 2, p.pos[2] + p.size[2] / 2]);
    this.explStep = zs.length ? Math.max(8, Math.min(40, (Math.max(...zs) - Math.min(...zs)) * 0.7)) : 8;
    this.faded = -1;
    this.applyXray();
    this.highlight(this.sel);
    this.applyAll();
  }

  private buildPart(p: BuiltPart) {
    const root = new THREE.Group();
    root.position.set(...p.pos);
    root.rotation.set(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R);
    root.updateMatrix();
    root.userData = { part: p, base: root.position.clone(), baseQ: root.quaternion.clone() } as RootData;
    root.visible = p.role !== 'ignore';
    this.roots.set(p.id, root);
    const inv = root.matrix.clone().invert();
    const segs = p.role === 'led' && p.segments && p.segments > 1 && (p.shape === 'tube' || p.shape === 'torus') ? p.segments : 0;
    // screen parts built from a mesh get planar UVs in partMeshGeometry
    const geos: { g: THREE.BufferGeometry; m: THREE.Material }[] = [];
    if (segs) for (let i = 0; i < segs; i++) {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), emissive: 0, roughness: 0.5 });
      this.ledMats.push(m); this.ownMats.push(m); geos.push({ g: shapeGeometry(p, { i, n: segs }), m });
    } else {
      let m: THREE.Material;
      const isScreen = this.screenOn?.id === p.id;
      // flat parts (and meshes given the Screen role, which get planar UVs) show the display across their face;
      // solid parts keep their look and get the display as a panel on their front (+Z) face
      const whole = isScreen && (p.shape === 'disc' || p.shape === 'rect' || (p.shape === 'mesh' && !this.screenOn!.auto));
      if (isScreen && !whole) geos.push({ g: frontPanel(p), m: this.screenMat });
      if (whole) m = this.screenMat;
      else if (p.role === 'led') { const lm = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), emissive: 0, roughness: 0.5 }); this.ledMats.push(lm); m = lm; this.ownMats.push(m); }
      else { m = material(p); this.ownMats.push(m); }
      geos.push({ g: shapeGeometry(p), m });
    }
    for (const inst of instances(p)) {
      const im = new THREE.Matrix4().compose(new THREE.Vector3(...inst.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...inst.rot.map(v => v * D2R) as [number, number, number])), new THREE.Vector3(1, 1, 1));
      const local = inv.clone().multiply(im);
      for (const { g, m } of geos) {
        const mesh = new THREE.Mesh(g, m);
        local.decompose(mesh.position, mesh.quaternion, mesh.scale);
        mesh.userData.part = p.id;
        root.add(mesh);
      }
    }
    return root;
  }

  private clearParts() {
    for (const r of this.roots.values()) { r.traverse((o: any) => o.geometry?.dispose()); this.mm.remove(r); }
    this.roots.clear();
    for (const m of this.ownMats) m.dispose();
    this.ownMats = []; this.ledMats = [];
  }

  applyXray() {
    const ex = 1 - this.explodeT * 0.84; // exploded: the enclosure fades so the electronics show
    for (const [, r] of this.roots) {
      const p = (r.userData as RootData).part, shell = p.kind === 'shell', xr = this.model.xray && shell, op = Math.min(xr ? 0.16 : 1, shell ? ex : 1), fade = op < 0.99;
      r.traverse((o: any) => {
        if (!o.isMesh || o.material === this.screenMat) return;
        const m = o.material as THREE.MeshPhysicalMaterial;
        const clear = p.finish === 'clear';
        m.transparent = fade || clear; m.opacity = fade ? op : clear ? 0.5 : 1; m.depthWrite = !fade;
        m.needsUpdate = true;
      });
    }
  }

  /** Base transform of a root after the modeler moved it (strips the explode offset). */
  rebase(root: THREE.Object3D) {
    const d = root.userData as RootData;
    d.base.copy(root.position); d.base.z -= (d.part.layer ?? 0) * this.explStep * this.explodeT;
    d.baseQ.copy(root.quaternion);
  }

  private applyAll() {
    const q = new THREE.Quaternion().setFromAxisAngle(this.pivot.axis, this.dialAngle), v = new THREE.Vector3();
    for (const r of this.roots.values()) {
      if (r === this.frozen) continue;
      const d = r.userData as RootData, p = d.part;
      r.position.copy(d.base); r.quaternion.copy(d.baseQ);
      if (p.role === 'dial' && this.pivot.on && this.dialAngle) {
        v.copy(d.base).sub(this.pivot.c).applyQuaternion(q); r.position.copy(this.pivot.c).add(v);
        r.quaternion.premultiply(q);
      }
      if ((p.role === 'press' || p.role === 'screen' || p.id === this.screenOn?.id) && this.pressDepth) r.position.z -= this.pressDepth * 0.8;
      if (this.explodeT) r.position.z += (p.layer ?? 0) * this.explStep * this.explodeT;
    }
  }

  pickables() { const out: THREE.Object3D[] = []; for (const r of this.roots.values()) if (r.visible) r.traverse(o => { if ((o as any).isMesh) out.push(o); }); return out; }
  roleOf(o: THREE.Object3D): Role { if (o.userData.part && o.userData.part === this.screenOn?.id) return 'screen' as Role; return (this.model.parts.find(p => p.id === o.userData.part)?.role as Role) ?? 'body'; }
  partOf(o: THREE.Object3D) { return o.userData.part as string; }
  dialCenter() { return this.mm.localToWorld(this.pivot.c.clone()); }
  explode(t: number) { this.explodeGoal = t; }

  highlight(part: string | null) {
    this.sel = part;
    for (const [id, r] of this.roots) r.traverse((o: any) => {
      const m = o.material;
      if (!o.isMesh || m === this.screenMat || this.ledMats.includes(m)) return;
      m.emissive?.setHex(id === part ? 0x1c3cff : 0); m.emissiveIntensity = id === part ? 0.3 : 1;
    });
  }

  tick(dt: number, now: number) {
    super.tick(dt, now);
    if (this.explodeT !== this.explodeGoal) { const s = Math.sign(this.explodeGoal - this.explodeT); this.explodeT = Math.max(0, Math.min(1, this.explodeT + s * dt * 2.5)); if (s !== Math.sign(this.explodeGoal - this.explodeT)) this.explodeT = this.explodeGoal; }
    if (Math.abs(this.faded - this.explodeT) > 0.01 || (this.faded !== this.explodeT && (this.explodeT === 0 || this.explodeT === 1))) { this.faded = this.explodeT; this.applyXray(); }
    this.applyAll();
  }

  protected applyDial() { this.applyAll(); }
  protected applyPress(depth: number) { this.pressDepth = depth; }
  protected applyLeds(c: [number, number, number][] | null, pulse: THREE.Color, t: number) {
    const M = this.ledMats.length; if (!M) return;
    this.ledMats.forEach((mat, i) => {
      if (c && c.length) {
        const a = Math.floor((i * c.length) / M), b = Math.max(a + 1, Math.floor(((i + 1) * c.length) / M));
        let r = 0, g = 0, bl = 0; for (let k = a; k < b; k++) { r += c[k][0]; g += c[k][1]; bl += c[k][2]; }
        const n = b - a; mat.emissive.setRGB(r / n / 255 * 1.4, g / n / 255 * 1.4, bl / n / 255 * 1.4);
      } else if (t > 0) mat.emissive.copy(pulse).multiplyScalar(t * 2);
      else mat.emissive.setHex(0);
    });
  }
  dispose() { this.clearParts(); this.screenMat.dispose(); this.screenTex.dispose(); this.group.clear(); }
}
