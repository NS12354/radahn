/**
 * URDF (ROS robot description) export and import.
 *
 * Formframe: mm, Y up, robot faces +Z, left = +X. ROS: metres, Z up, x forward,
 * y left. So ROS (x, y, z) = Formframe (z, x, y): a cyclic permutation, which is
 * a proper rotation, applied to every point, axis and orientation.
 *
 * Export: each part with a joint (or the root) starts a link; parts attached
 * without a joint become extra visuals of their parent's link. Link frames sit
 * at the joint pivot with the world's orientation at rest, so joint origins are
 * pure translations and axes are the rest-pose axes. Shapes map to box /
 * cylinder / sphere (others as their bounding box), with box inertia from the
 * part's size at plastic density, so the URDF loads in RViz and Gazebo.
 */
import * as THREE from 'three';
import type { BuiltModel, BuiltPart, Joint } from './project';
import { newUid } from './project';

const D2R = Math.PI / 180;
type V3 = [number, number, number];
/** Formframe → ROS vector (mm → m when `scale`). */
const toRos = (v: V3 | THREE.Vector3, scale = 0.001): V3 => { const a = Array.isArray(v) ? v : [v.x, v.y, v.z]; return [a[2] * scale, a[0] * scale, a[1] * scale]; };
const fromRos = (v: V3, scale = 1000): V3 => [v[1] * scale, v[2] * scale, v[0] * scale];
const P = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1); // ROS = P · Formframe
const Pinv = P.clone().invert();
const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(6)));
const xyz = (v: V3) => v.map(f).join(' ');
const slug = (s: string, used: Set<string>) => { let b = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'link'; let n = b, k = 2; while (used.has(n)) n = `${b}_${k++}`; used.add(n); return n; };

/** URDF geometry for a part, and its orientation (rpy, ROS). Part-local Formframe axes (x, y, z) are ROS-local (y, z, x). */
function visualOf(p: BuiltPart): { xml: string; rpy: V3 } {
  const s = p.size.map(v => v / 1000) as V3;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot[0] * D2R, p.rot[1] * D2R, p.rot[2] * D2R));
  let r = P.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(Pinv);
  let xml: string;
  if (p.shape === 'sphere') xml = `<sphere radius="${f(Math.max(...s) / 2)}"/>`;
  else if (p.shape === 'cyl' || p.shape === 'tube' || p.shape === 'disc') {
    // a Formframe cylinder runs along its local Z = ROS-local x; URDF cylinders run along local z: turn y +90° (z → x)
    r = r.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    xml = `<cylinder radius="${f(Math.max(s[0], s[1]) / 2)}" length="${f(s[2] || 0.001)}"/>`;
  } else xml = `<box size="${xyz([s[2] || 0.001, s[0], s[1]])}"/>`;
  const e = new THREE.Euler().setFromRotationMatrix(r, 'ZYX'); // URDF rpy = fixed-axis X, Y, Z = intrinsic Z-Y-X
  return { xml, rpy: [e.x, e.y, e.z] };
}

/** Links of a model: each part with a moving joint (or no parent) heads a link; names are URDF-safe and unique. */
function linksOf(m: BuiltModel) {
  const parts = m.parts.filter(p => p.role !== 'ignore');
  const byId = new Map(parts.map(p => [p.id, p]));
  // the link each part belongs to: itself if it has a (moving) joint or no parent, else its parent's link
  const linkOf = (p: BuiltPart): BuiltPart => { let q = p, n = 0; while (q.parent && byId.has(q.parent) && !(q.joint && q.joint.type !== 'fixed') && n++ < 64) q = byId.get(q.parent)!; return q; };
  const heads = parts.filter(p => linkOf(p) === p);
  const used = new Set<string>(['base_link']), names = new Map<string, string>();
  for (const h of heads) names.set(h.id, slug(h.name, used));
  return { parts, byId, linkOf, heads, names };
}
/** URDF joint name for each moving part (what /joint_states uses). */
export function urdfJointNames(m: BuiltModel): Map<string, string> {
  const { heads, names } = linksOf(m);
  return new Map(heads.filter(h => h.joint && h.joint.type !== 'fixed').map(h => [h.id, `${names.get(h.id)}_joint`]));
}

export function exportUrdf(m: BuiltModel, name = 'formframe_robot'): string {
  const { parts, byId, linkOf, heads, names } = linksOf(m);
  const root = 'base_link';
  /** Link frame origin (Formframe, mm): the joint pivot, or the world origin for root links. */
  const origin = (h: BuiltPart): V3 => (h.joint ? h.joint.pivot : [0, 0, 0]);
  const out: string[] = [`<?xml version="1.0"?>`, `<!-- Exported from Formframe. Units: metres, radians. Z up, x forward. -->`, `<robot name="${slug(name, new Set())}">`, `  <link name="${root}"/>`];
  for (const h of heads) {
    const o = origin(h), members = parts.filter(p => linkOf(p) === h);
    let mass = 0; const com = new THREE.Vector3(); let ixx = 0, iyy = 0, izz = 0;
    out.push(`  <link name="${names.get(h.id)}">`);
    for (const p of members) {
      const rel = toRos([p.pos[0] - o[0], p.pos[1] - o[1], p.pos[2] - o[2]]), g = visualOf(p);
      out.push(`    <visual name="${slug(p.name, new Set())}"><origin xyz="${xyz(rel)}" rpy="${xyz(g.rpy)}"/><geometry>${g.xml}</geometry><material name="${p.color}"><color rgba="${new THREE.Color(p.color).toArray().map(f).join(' ')} 1"/></material></visual>`);
      if (p.kind !== 'shell' || members.length === 1) out.push(`    <collision><origin xyz="${xyz(rel)}" rpy="${xyz(g.rpy)}"/><geometry>${g.xml}</geometry></collision>`);
      const [a, b, c] = toRos(p.size), vol = Math.abs(a * b * c) * (p.shape === 'sphere' ? 0.52 : p.shape === 'cyl' ? 0.785 : 1);
      const mm = Math.max(0.001, vol * 1200 * (p.kind === 'internal' ? 1.5 : 0.35)); // plastic, printed parts ~35 % infill
      mass += mm; com.add(new THREE.Vector3(...rel).multiplyScalar(mm));
      ixx += mm / 12 * (b * b + c * c); iyy += mm / 12 * (a * a + c * c); izz += mm / 12 * (a * a + b * b);
    }
    com.divideScalar(Math.max(1e-9, mass));
    out.push(`    <inertial><origin xyz="${xyz([com.x, com.y, com.z])}" rpy="0 0 0"/><mass value="${f(mass)}"/><inertia ixx="${f(ixx)}" ixy="0" ixz="0" iyy="${f(iyy)}" iyz="0" izz="${f(izz)}"/></inertial>`);
    out.push(`  </link>`);
    // the joint into this link
    const par = h.parent && byId.has(h.parent) ? linkOf(byId.get(h.parent)!) : null;
    const po = par ? origin(par) : ([0, 0, 0] as V3);
    const j = h.joint && h.joint.type !== 'fixed' ? h.joint : null;
    const type = !j ? 'fixed' : j.type === 'wheel' ? 'continuous' : j.type;
    const limit = j && j.type === 'revolute' ? `<limit lower="${f((j.min ?? -180) * D2R)}" upper="${f((j.max ?? 180) * D2R)}" effort="${f(1.1)}" velocity="${f(6)}"/>` : j && j.type === 'prismatic' ? `<limit lower="${f((j.min ?? 0) / 1000)}" upper="${f((j.max ?? 10) / 1000)}" effort="20" velocity="0.1"/>` : '';
    out.push(`  <joint name="${names.get(h.id)}_joint" type="${type}"><parent link="${par ? names.get(par.id) : root}"/><child link="${names.get(h.id)}"/><origin xyz="${xyz(toRos([o[0] - po[0], o[1] - po[1], o[2] - po[2]]))}" rpy="0 0 0"/>${j ? `<axis xyz="${xyz(toRos(new THREE.Vector3(...j.axis).normalize(), 1))}"/>` : ''}${limit}</joint>`);
  }
  out.push(`</robot>`, '');
  return out.join('\n');
}

// ------------------------------------------------------------------ import
interface XNode { tag: string; attrs: Record<string, string>; kids: XNode[] }
/** A small XML parser (elements and attributes only), enough for URDF. Throws on unbalanced tags. */
export function parseXml(src: string): XNode {
  const root: XNode = { tag: '#doc', attrs: {}, kids: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) { const top = stack.pop(); if (!top || top.tag !== m[1]) throw new Error(`Unbalanced </${m[1]}> in the URDF.`); continue; }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const n: XNode = { tag: m[2], attrs, kids: [] };
    stack[stack.length - 1].kids.push(n);
    if (!m[4]) stack.push(n);
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].tag}> is never closed in the URDF.`);
  return root;
}
const kid = (n: XNode | undefined, tag: string) => n?.kids.find(k => k.tag === tag);
const kids = (n: XNode | undefined, tag: string) => n?.kids.filter(k => k.tag === tag) ?? [];

/** Parse a URDF into parts with joints (box / cylinder / sphere visuals; meshes become 20 mm placeholder boxes). */
export function importUrdf(xml: string): { parts: BuiltPart[]; notes: string[]; name: string } {
  const robot = kid(parseXml(xml), 'robot'); if (!robot) throw new Error('No <robot> element: is this a URDF?');
  const num = (s: string | undefined, n = 3) => { const a = (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number).filter(x => !isNaN(x)); while (a.length < n) a.push(0); return a as V3; };
  const notes: string[] = [];
  const links = new Map<string, XNode>(); for (const l of kids(robot, 'link')) links.set(l.attrs.name, l);
  const parentOf = new Map<string, { joint: XNode; parent: string }>();
  for (const j of kids(robot, 'joint')) { const c = kid(j, 'child')?.attrs.link, p = kid(j, 'parent')?.attrs.link; if (c && p) parentOf.set(c, { joint: j, parent: p }); }
  const frame = new Map<string, THREE.Matrix4>();
  const tf = (o: XNode | undefined) => { const t = num(o?.attrs.xyz), r = num(o?.attrs.rpy); return new THREE.Matrix4().compose(new THREE.Vector3(...t), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'ZYX')), new THREE.Vector3(1, 1, 1)); };
  const frameOf = (name: string, depth = 0): THREE.Matrix4 => {
    if (frame.has(name)) return frame.get(name)!;
    const pj = parentOf.get(name);
    const m = pj && depth < 128 ? frameOf(pj.parent, depth + 1).clone().multiply(tf(kid(pj.joint, 'origin'))) : new THREE.Matrix4();
    frame.set(name, m); return m;
  };
  const parts: BuiltPart[] = [], mainPart = new Map<string, BuiltPart>();
  const palette = ['#d9dde3', '#ff7a2f', '#2a2d33', '#3aa0ff', '#33c27f'];
  let meshes = 0;
  for (const [name, link] of links) {
    const F = frameOf(name);
    const visuals: (XNode | undefined)[] = kids(link, 'visual');
    if (!visuals.length) { if (!parentOf.has(name)) continue; visuals.push(undefined); } // an empty root (base_link) needs no part
    visuals.forEach((v, i) => {
      const W = F.clone().multiply(tf(kid(v, 'origin')));
      const g = kid(v, 'geometry');
      let shape: BuiltPart['shape'] = 'box', size: V3 = [20, 20, 20];
      const box = kid(g, 'box'), cyl = kid(g, 'cylinder'), sph = kid(g, 'sphere');
      if (box) size = num(box.attrs.size).map(x => x * 1000) as V3;
      else if (cyl) { const r = +(cyl.attrs.radius ?? 0.01) * 1000, l = +(cyl.attrs.length ?? 0.02) * 1000; shape = 'cyl'; size = [2 * r, 2 * r, l]; }
      else if (sph) { const r = +(sph.attrs.radius ?? 0.01) * 1000; shape = 'sphere'; size = [2 * r, 2 * r, 2 * r]; }
      else if (kid(g, 'mesh')) meshes++;
      else if (!v) size = [10, 10, 10];
      // the visual frame in Formframe space; part-local axes = the visual's axes permuted (ROS-local x, y, z = Formframe-local z, x, y)
      const Wf = Pinv.clone().multiply(W).multiply(P);
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); Wf.decompose(pos, q, sc); pos.multiplyScalar(1000); // m → mm
      // URDF cylinders run along ROS-local z = Formframe-local y; Formframe cylinders along local Z: turn x −90° (Z → Y)
      if (shape === 'cyl') q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      const rgba = kid(kid(v, 'material'), 'color')?.attrs.rgba;
      const r3 = (x: number, k = 1000) => Math.round(x * k) / k;
      const part: BuiltPart = {
        id: newUid(), name: i ? `${name} ${i + 1}` : name, shape,
        size: shape === 'box' ? [size[1], size[2], size[0]] : size,
        pos: [r3(pos.x, 100), r3(pos.y, 100), r3(pos.z, 100)],
        rot: [r3(e.x / D2R), r3(e.y / D2R), r3(e.z / D2R)],
        color: rgba ? '#' + new THREE.Color(...num(rgba, 3)).getHexString() : palette[parts.length % palette.length], finish: 'satin', role: 'body', layer: 0,
      };
      if (i) part.parent = mainPart.get(name)?.id; else mainPart.set(name, part);
      parts.push(part);
    });
  }
  for (const [child, { joint, parent }] of parentOf) {
    const p = mainPart.get(child), par = mainPart.get(parent); if (!p) continue;
    if (par) p.parent = par.id;
    const type = joint.attrs.type;
    if (!type || type === 'fixed' || type === 'floating' || type === 'planar') { if (type === 'floating' || type === 'planar') notes.push(`Joint ${joint.attrs.name} is ${type}: imported as fixed.`); continue; }
    const F = frameOf(child), axis = new THREE.Vector3(...num(kid(joint, 'axis')?.attrs.xyz ?? '1 0 0')).transformDirection(F);
    const piv = new THREE.Vector3().setFromMatrixPosition(F);
    const lim = kid(joint, 'limit');
    const j: Joint = {
      type: type === 'continuous' ? 'wheel' : type === 'prismatic' ? 'prismatic' : 'revolute',
      pivot: fromRos([piv.x, piv.y, piv.z]).map(x => Math.round(x * 100) / 100) as V3,
      axis: fromRos([axis.x, axis.y, axis.z], 1).map(x => Math.round(x * 1e6) / 1e6) as V3,
    };
    if (lim && type === 'revolute') { j.min = +(lim.attrs.lower ?? -Math.PI) / D2R; j.max = +(lim.attrs.upper ?? Math.PI) / D2R; }
    if (lim && type === 'prismatic') { j.min = +(lim.attrs.lower ?? 0) * 1000; j.max = +(lim.attrs.upper ?? 0.01) * 1000; }
    p.joint = j;
  }
  if (meshes) notes.push(`${meshes} mesh visual${meshes > 1 ? 's' : ''} (STL/DAE files) became 20 mm placeholder boxes. Resize them, or import the meshes as CAD.`);
  notes.push(`${parentOf.size} joints, ${links.size} links. Give each joint a driver (servo, PCA9685 channel, motor) in the Design inspector.`);
  return { parts, notes, name: robot.attrs.name ?? 'Imported robot' };
}
