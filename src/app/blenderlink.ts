import * as THREE from 'three';
import type { BuiltModel, BuiltPart } from './project';
import { newUid } from './project';
import { toEMesh, writeEMesh, type EMesh, type V } from '../scene/mesh';

/**
 * Live link with Blender (see server/blender.mjs and blender/formframe_link.py).
 *
 * Blender space is Z-up millimetres; Formframe parts are Y-up with the front
 * on +Z. M maps ours → Blender: (x, y, z) → (x, −z, y).
 *
 * Each part carries `bl` after it has been through Blender: the geometry hash
 * Blender reported, a signature of our geometry at that moment, and Blender's
 * own object matrix. While our geometry still matches that signature we send
 * Blender's hash and its matrix back, so Blender keeps its own base mesh,
 * modifiers and origin instead of receiving our baked copy.
 */
export type BlenderTrace = NonNullable<BuiltPart['bl']>;
type BPart = { id: string; name: string; kind: string; role: string; layer: number; finish: string; color: string; segments: number; auto: boolean; comp: string | null; smooth: boolean; matrix: number[]; hash: string; mesh?: { v: number[]; f: number[][]; e?: [number, number][] }; array: any };
export interface BModel { name: string; units: 'mm'; parts: BPart[] }

const M = new THREE.Matrix4().makeRotationX(Math.PI / 2), Mi = M.clone().invert();
const D2R = Math.PI / 180;
const objMatrix = (pos: number[], rot: number[]) => new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, 'XYZ')), new THREE.Vector3(1, 1, 1));
const toB = (q: V): V => [q[0], -q[2], q[1]];
const fromB = (q: V): V => [q[0], q[2], -q[1]];

/** Same canonical text + FNV-1a as the add-on's geo_hash(). */
const fmt = (x: number) => { const s = x.toFixed(3); return s === '-0.000' ? '0.000' : s; };
export function geoHash(v: V[], f: number[][]) {
  const canon = v.map(q => `${fmt(q[0])},${fmt(q[1])},${fmt(q[2])}`).join(';') + '|' + f.map(x => x.join(',')).join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) { h ^= canon.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const geoSig = (p: BuiltPart) => JSON.stringify([p.shape, p.size, p.param ?? null, p.mesh ?? null, !!p.smooth]);

// ------------------------------------------------------------------ Formframe → Blender
export function toBlender(name: string, b: BuiltModel): BModel {
  const parts = b.parts.map(p => {
    const tr = p.bl, same = !!tr && tr.sig === geoSig(p);
    const em: EMesh = toEMesh(p), v = em.v.map(q => toB(q).map(x => Math.round(x * 1e4) / 1e4) as V); // hash exactly what Blender will store
    const cur = objMatrix(p.pos, p.rot);
    let matB: THREE.Matrix4;
    if (same) { // keep Blender's own origin: apply only what moved here since it came back
      const old = objMatrix(tr!.pos, tr!.rot);
      matB = new THREE.Matrix4().multiplyMatrices(M, cur).multiply(old.clone().invert()).multiply(Mi).multiply(new THREE.Matrix4().fromArray(tr!.matrix));
    } else matB = new THREE.Matrix4().multiplyMatrices(M, cur).multiply(Mi);
    const hash = same ? tr!.hash : geoHash(v, em.f);
    let array: any = null;
    if (p.array && p.array.n > 1) {
      if (p.array.mode === 'radial') array = { n: p.array.n, mode: 'radial', center: p.array.center ?? [0, 0] };
      else { // step is in the parent frame; Blender's Array modifier offsets in object space
        const s = p.array.step ?? [10, 0, 0], world = new THREE.Vector3(s[0], -s[2], s[1]);
        const q = new THREE.Quaternion(); matB.decompose(new THREE.Vector3(), q, new THREE.Vector3());
        const l = world.applyQuaternion(q.invert());
        array = { n: p.array.n, mode: 'linear', step: [l.x, l.y, l.z] };
      }
    }
    return {
      id: p.id, name: p.name, kind: p.kind ?? 'ext', role: p.role, layer: p.layer ?? 0, finish: p.finish, color: p.color, segments: p.segments ?? 0,
      auto: !!p.auto, comp: p.comp ?? null, smooth: !!p.smooth, matrix: matB.toArray(), hash,
      mesh: { v: v.flat(), f: em.f, e: em.e.length ? em.e : undefined }, array,
    } as BPart;
  });
  return { name, units: 'mm', parts };
}

// ------------------------------------------------------------------ Blender → Formframe
/** Merge Blender's model into ours. Parts missing in Blender are deleted; new Blender objects become parts. */
export function fromBlender(m: BModel, cur: BuiltModel): { built: BuiltModel; added: number; removed: number; meshes: number } {
  const byId = new Map(cur.parts.map(p => [p.id, p]));
  let added = 0, meshes = 0;
  const parts: BuiltPart[] = [];
  for (const b of m.parts) {
    const old = byId.get(b.id);
    if (!old && !b.mesh) continue; // nothing to build it from
    const p: BuiltPart = old ? JSON.parse(JSON.stringify(old)) : { id: b.id || newUid(), name: b.name, shape: 'mesh', size: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, 0], color: b.color, finish: b.finish, role: 'body' } as BuiltPart;
    if (!old) added++;
    const O = new THREE.Matrix4().multiplyMatrices(Mi, new THREE.Matrix4().fromArray(b.matrix)).multiply(M);
    const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); O.decompose(t, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    p.pos = [t.x, t.y, t.z].map(r4) as V; p.rot = [e.x, e.y, e.z].map(x => r4(x / D2R)) as V;
    if (b.mesh) {
      const v: V[] = []; for (let i = 0; i + 2 < b.mesh.v.length; i += 3) { const o = fromB([b.mesh.v[i], b.mesh.v[i + 1], b.mesh.v[i + 2]]); v.push([o[0] * s.x, o[1] * s.y, o[2] * s.z]); }
      p.rot = [e.x, e.y, e.z].map(x => r4(x / D2R)) as V;
      writeEMesh(p, { v, f: b.mesh.f.map(f => [...f]), e: (b.mesh.e ?? []).map(x => [...x] as [number, number]) });
      meshes++;
    } else if (Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-4) {
      p.size = [p.size[0] * s.x, p.size[1] * s.y, p.size[2] * s.z].map(r4) as V; // scaled in Blender without new geometry
    }
    p.name = b.name; p.kind = b.kind === 'shell' || b.kind === 'internal' ? b.kind : undefined;
    p.role = (['body', 'dial', 'screen', 'press', 'led', 'ignore'].includes(b.role) ? b.role : 'body') as BuiltPart['role'];
    p.layer = b.layer || 0; p.finish = b.finish; p.color = b.color || p.color; p.smooth = b.smooth;
    p.segments = b.segments || undefined; p.auto = b.auto || undefined; p.comp = b.comp ?? p.comp;
    if (b.array?.mode === 'linear' && b.array.n > 1) {
      const qB = new THREE.Quaternion(); new THREE.Matrix4().fromArray(b.matrix).decompose(new THREE.Vector3(), qB, new THREE.Vector3());
      const w = new THREE.Vector3(...(b.array.step as V)).applyQuaternion(qB); // object → Blender world
      p.array = { n: b.array.n, mode: 'linear', step: fromB([w.x, w.y, w.z]).map(r4) as V };
    } else if (b.array?.mode === 'radial') p.array = { n: b.array.n, mode: 'radial', center: b.array.center ?? [0, 0] };
    else p.array = undefined;
    p.bl = { hash: b.hash, sig: geoSig(p), matrix: b.matrix, pos: [...p.pos], rot: [...p.rot] } as BlenderTrace;
    parts.push(p);
  }
  const removed = cur.parts.filter(p => !m.parts.some(b => b.id === p.id)).length;
  return { built: { ...cur, parts }, added, removed, meshes };
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ------------------------------------------------------------------ client (runs in the studio window)
export interface LinkHost {
  projectId(): string | null;
  projectName(): string;
  built(): BuiltModel | null;
  apply(b: BuiltModel, note: string): Promise<void>;
  status(s: { linked: boolean; blender: boolean; text: string }): void;
}
export class BlenderLink {
  private rev = 0;
  private timer: any = null;
  private pushT: any = null;
  private lastSig = '';
  private id: string | null = null;
  linked = false;
  constructor(private h: LinkHost, private base: string) {}

  /** Launch Blender (if needed) and start syncing this project. */
  async open() {
    const id = this.h.projectId(); if (!id) throw new Error('Open a saved project first');
    const r = await fetch(this.base + 'api/blender/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: id, name: this.h.projectName() }) }).catch(() => null);
    if (!r) throw new Error('Could not reach the Formframe dev server. The Blender link needs `npm run dev`.');
    if (r.status === 404 && !(await r.clone().json().catch(() => null))?.error) throw new Error('This build has no server, so it can’t talk to Blender. Run `npm run dev`.');
    const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Could not start Blender');
    this.start(id);
    await this.push(true);
    return j as { launched?: boolean; already?: boolean };
  }
  start(id: string) {
    if (this.id !== id) { this.rev = 0; this.lastSig = ''; }
    this.id = id; this.linked = true;
    clearInterval(this.timer); this.timer = setInterval(() => this.poll(), 1000);
    this.h.status({ linked: true, blender: false, text: 'Starting Blender…' });
  }
  stop() { this.linked = false; clearInterval(this.timer); this.timer = null; this.id = null; this.h.status({ linked: false, blender: false, text: '' }); }
  /** Our model changed: send it (debounced). */
  changed() { if (!this.linked) return; clearTimeout(this.pushT); this.pushT = setTimeout(() => this.push(), 300); }
  /** Resume after a reload if Blender is still linked to this project. */
  async resume(id: string) {
    const r = await fetch(this.base + `api/blender/poll?project=${encodeURIComponent(id)}&since=0&for=formframe`).then(x => x.ok ? x.json() : null).catch(() => null);
    if (r?.blender) { this.start(id); this.rev = r.rev; this.push(true); }
  }
  private async push(force = false) {
    const b = this.h.built(); if (!this.linked || !this.id || !b || this.id !== this.h.projectId()) return;
    const model = toBlender(this.h.projectName(), b), sig = JSON.stringify(model);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    const r = await fetch(this.base + 'api/blender/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: this.id, from: 'formframe', model }) }).then(x => x.json()).catch(() => null);
    if (r?.rev) this.rev = r.rev;
  }
  private busy = false;
  private async poll() {
    if (!this.linked || !this.id || this.busy) return;
    if (this.id !== this.h.projectId()) { this.stop(); return; }
    this.busy = true;
    try {
      const r = await fetch(this.base + `api/blender/poll?project=${encodeURIComponent(this.id)}&since=${this.rev}&for=formframe`).then(x => x.json()).catch(() => null);
      if (!r) { this.h.status({ linked: true, blender: false, text: 'Dev server not reachable' }); return; }
      this.h.status({ linked: true, blender: !!r.blender, text: r.blender ? 'Blender linked' : 'Waiting for Blender…' });
      if (r.model) {
        this.rev = r.rev;
        const cur = this.h.built() ?? { parts: [], xray: false, auto: undefined as any, notes: [] };
        const res = fromBlender(r.model, cur);
        await this.h.apply(res.built, `From Blender: ${res.meshes} mesh${res.meshes === 1 ? '' : 'es'} updated${res.added ? `, ${res.added} new` : ''}${res.removed ? `, ${res.removed} removed` : ''}`);
        this.lastSig = ''; this.push(true); // echo our merged copy so Blender refreshes radial previews; it changes nothing else there
      }
    } finally { this.busy = false; }
  }
}
