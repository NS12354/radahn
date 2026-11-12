import * as THREE from 'three';
import { Product, type Role } from './product';
import type { Project, PartKey } from '../app/project';
import { INTERNALS, fitCheck } from '../app/internals';

export const FINISHES: Record<string, { r: number; m: number; cc?: number }> = {
  matte: { r: 0.78, m: 0 }, satin: { r: 0.45, m: 0 }, gloss: { r: 0.12, m: 0, cc: 1 },
  soft: { r: 0.95, m: 0 }, brushed: { r: 0.32, m: 0.92 }, polished: { r: 0.08, m: 1 },
};

/** The built-in parametric round thermostat (diameter/depth driven). */
export class ParametricProduct extends Product {
  private M: any = {};
  private explodeT = 0;
  private explodeGoal = 0;
  private sel: string | null = null;
  /** Show the generic internal stack (fit/BOM spec) when exploded; off when real electronics are shown instead. */
  genericInternals = true;

  constructor(private project: Project) { super(); this.build(); }

  private mat(k: PartKey) {
    const p = this.project.product.parametric.parts[k], f = FINISHES[p.finish] ?? FINISHES.matte;
    return new THREE.MeshPhysicalMaterial({ color: new THREE.Color(p.color), roughness: f.r, metalness: f.m, clearcoat: f.cc ?? 0, clearcoatRoughness: 0.08, side: THREE.DoubleSide, transparent: true });
  }

  build() {
    this.disposeChildren();
    const { dia, depth } = this.project.product.parametric;
    const R = dia / 20, D = depth / 10, back = -D / 2, front = D / 2;
    const M: any = (this.M = { R, D });
    const tag = (o: THREE.Object3D, part: PartKey, role: Role) => { o.userData.part = part; o.userData.role = role; return o; };

    const mount = tag(new THREE.Mesh(new THREE.CylinderGeometry(R * 1.22, R * 1.22, 0.18, 96), this.mat('mount')), 'mount', 'mount') as THREE.Mesh;
    mount.rotation.x = Math.PI / 2; mount.position.z = back - 0.09; this.group.add(mount); M.mount = mount;
    const bodyLen = D * 0.6;
    const body = tag(new THREE.Mesh(new THREE.CylinderGeometry(R * 0.955, R * 0.975, bodyLen, 128), this.mat('body')), 'body', 'body') as THREE.Mesh;
    body.rotation.x = Math.PI / 2; body.position.z = back + bodyLen / 2; this.group.add(body); M.body = body;

    const fg = new THREE.Group(); this.group.add(fg); M.front = fg;
    const dialLen = D - bodyLen;
    const dial = new THREE.Group(); fg.add(dial); M.dial = dial;
    const dmat = this.mat('dial');
    const shell = tag(new THREE.Mesh(new THREE.CylinderGeometry(R, R, dialLen, 128, 1, true), dmat), 'dial', 'dial');
    shell.rotation.x = Math.PI / 2; shell.position.z = back + bodyLen + dialLen / 2; dial.add(shell);
    const df = tag(new THREE.Mesh(new THREE.RingGeometry(R * 0.82, R, 128), dmat), 'dial', 'dial'); df.position.z = front; dial.add(df);
    const db = tag(new THREE.Mesh(new THREE.RingGeometry(R * 0.82, R, 128), dmat), 'dial', 'dial'); db.position.z = back + bodyLen + 0.002; dial.add(db);
    const rg = new THREE.BoxGeometry(0.035, 0.06, dialLen * 0.86);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r = tag(new THREE.Mesh(rg, dmat), 'dial', 'dial');
      r.position.set(Math.cos(a) * R, Math.sin(a) * R, back + bodyLen + dialLen / 2); r.rotation.z = a; dial.add(r);
    }
    const notch = tag(new THREE.Mesh(new THREE.BoxGeometry(0.06, R * 0.1, 0.02), new THREE.MeshStandardMaterial({ color: 0xff7a2f, emissive: 0xff7a2f, emissiveIntensity: 0.6 })), 'dial', 'dial');
    notch.position.set(0, R * 0.91, front + 0.006); dial.add(notch);

    const face = tag(new THREE.Mesh(new THREE.CircleGeometry(R * 0.82, 128), this.mat('face')), 'face', 'press') as THREE.Mesh;
    face.position.z = front - 0.04; (face.material as any).envMapIntensity = 0.3; fg.add(face); M.face = face;

    const led = new THREE.Group(); led.position.z = front - 0.02; fg.add(led); M.ledSegs = [];
    const arc = (Math.PI * 2) / 24 * 0.9, sg = new THREE.TorusGeometry(R * 0.79, 0.022, 8, 10, arc);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.project.product.parametric.parts.led.color), emissive: 0, roughness: 0.9, envMapIntensity: 0.15 });
      const s = tag(new THREE.Mesh(sg, m), 'led', 'press');
      s.rotation.z = Math.PI / 2 - (i + 1) * (Math.PI * 2) / 24 + ((Math.PI * 2) / 24 - arc) / 2;
      s.userData.seg = true; led.add(s); M.ledSegs.push(s);
    }
    const screen = tag(new THREE.Mesh(new THREE.CircleGeometry(R * 0.62, 128), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false })), 'face', 'press');
    screen.position.z = front - 0.02; screen.userData.screen = true; fg.add(screen); M.screen = screen;

    const ig = new THREE.Group(); this.group.add(ig); M.int = ig; ig.visible = false;
    this.buildInternals();
    this.applyMaterials();
    this.applyDial();
  }

  buildInternals() {
    const ig: THREE.Group = this.M.int;
    ig.children.slice().forEach(c => { ig.remove(c); (c as THREE.Mesh).geometry.dispose(); });
    const fit = fitCheck(this.project);
    const D = this.M.D; let z = D / 2 - 0.25;
    for (const c of INTERNALS.filter(c => this.project.internals[c.id] && c.shape !== 'onpcb')) {
      const h = c.h! / 10, bad = fit.bad.has(c.id);
      const m = new THREE.MeshStandardMaterial({ color: bad ? 0xff4d4d : c.col, roughness: 0.6, metalness: 0.1, emissive: bad ? 0x550000 : 0 });
      const g = c.shape === 'disc' ? new THREE.CylinderGeometry(c.d! / 20, c.d! / 20, h, 64) : new THREE.BoxGeometry(c.w! / 10, h, c.l! / 10);
      const mesh = new THREE.Mesh(g, m); mesh.rotation.x = Math.PI / 2;
      z -= h / 2; mesh.position.z = z; mesh.userData.restZ = z; z -= h / 2 + 0.1;
      ig.add(mesh);
    }
  }

  applyMaterials() {
    const parts = this.project.product.parametric.parts;
    const set = (m: THREE.MeshPhysicalMaterial, k: PartKey) => { const p = parts[k], f = FINISHES[p.finish] ?? FINISHES.matte; m.color.set(p.color); m.roughness = f.r; m.metalness = f.m; m.clearcoat = f.cc ?? 0; };
    set(this.M.body.material, 'body'); set(this.M.mount.material, 'mount'); set(this.M.face.material, 'face');
    this.M.dial.children.forEach((o: any) => { if (o.material.isMeshPhysicalMaterial) set(o.material, 'dial'); });
    this.M.ledSegs.forEach((s: any) => s.material.color.set(parts.led.color));
    this.highlight(this.sel);
  }

  highlight(part: string | null) {
    this.sel = part;
    this.group.traverse((o: any) => {
      if (!o.isMesh || !o.userData.part || o.userData.seg || o.userData.screen || !o.material?.emissive || o.parent === this.M.int) return;
      const on = part != null && o.userData.part === part;
      o.material.emissive.setHex(on ? 0x1c3cff : 0); o.material.emissiveIntensity = on ? 0.22 : 1;
    });
  }

  explode(goal: number) { this.explodeGoal = goal; }

  pickables() { const out: THREE.Object3D[] = []; this.group.traverse(o => { if ((o as any).isMesh && o.userData.role && o.parent !== this.M.int) out.push(o); }); return out; }
  roleOf(o: THREE.Object3D): Role { return o.userData.role ?? 'body'; }
  partOf(o: THREE.Object3D) { return o.userData.part ?? 'body'; }
  dialCenter() { return new THREE.Vector3(0, 0, this.M.D / 2).applyMatrix4(this.M.front.matrixWorld); }
  protected applyDial() { if (this.M.dial) this.M.dial.rotation.z = this.dialAngle; }
  protected applyLeds(c: [number, number, number][] | null, pulse: THREE.Color, t: number) {
    this.M.ledSegs.forEach((s: any, i: number) => {
      if (c && c[i]) s.material.emissive.setRGB((c[i][0] / 255) * 1.3, (c[i][1] / 255) * 1.3, (c[i][2] / 255) * 1.3);
      else if (t > 0) s.material.emissive.copy(pulse).multiplyScalar(t * 2.2);
      else s.material.emissive.setHex(0);
    });
  }
  protected applyPress(depth: number) {
    const M = this.M;
    this.explodeT += (this.explodeGoal - this.explodeT) * 0.12;
    const t = this.explodeT, D = M.D;
    M.front.position.z = t * D * 1.1 - depth * 0.04 * (1 - t);
    M.int.visible = t > 0.02 && this.genericInternals;
    M.int.children.forEach((c: any, i: number) => { c.position.z = c.userData.restZ + t * (D * 0.55 - i * D * 0.28); });
    M.mount.position.z = -D / 2 - 0.09 - t * D * 0.6;
    const op = 1 - t * 0.82; M.body.material.opacity = op; M.body.material.depthWrite = op > 0.9;
  }

  private disposeChildren() {
    this.group.traverse((o: any) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map !== this.screenTex) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose()); });
    this.group.clear();
  }
  dispose() { this.disposeChildren(); }
}
