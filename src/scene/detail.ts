/**
 * Detailed models of real hardware, built procedurally (no asset files):
 * servos, wheels and tyres, gear motors, circuit boards (per board family),
 * sensor modules, aluminium links, batteries, casters, feet.
 *
 * A part opts in with `detail` (e.g. "servo:mg996r", "pcb:picow", "module:hcsr04").
 * Each builder fills the part's size box, centred on the part origin, in mm.
 * Conventions match the plain shapes: cylinders/wheels run along local Z; circuit
 * boards lie in local XY with components on +Z; servos have their shaft on +Y.
 * Textures (PCB traces, tyre tread, brushed metal, print lines) are drawn on
 * canvases once and shared.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type V3 = [number, number, number];

// ------------------------------------------------------------------ textures
const texCache = new Map<string, THREE.Texture>();
function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, color = true): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  if (texCache.has(key)) return texCache.get(key)!;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t); return t;
}
/** Seeded random, so textures look the same every time. */
function rnd(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Solder mask with copper traces, vias and silkscreen. */
function pcbTex(color: string, seed = 1) {
  return canvasTex(`pcb${color}${seed}`, 512, 512, (g, w, h) => {
    const r = rnd(seed), base = new THREE.Color(color);
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.strokeStyle = `#${base.clone().multiplyScalar(1.35).getHexString()}`; g.lineCap = 'round';
    for (let i = 0; i < 90; i++) { // traces: 45° routing like a real board
      g.lineWidth = 2 + r() * 4; g.beginPath(); let x = r() * w, y = r() * h; g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { const d = (20 + r() * 90) * (r() < 0.5 ? -1 : 1); if (r() < 0.5) x += d; else y += d; if (r() < 0.3) { x += d * 0.5; y += d * 0.5; } g.lineTo(x, y); }
      g.stroke();
    }
    g.fillStyle = '#c9a66b';
    for (let i = 0; i < 140; i++) { g.beginPath(); g.arc(r() * w, r() * h, 2 + r() * 2, 0, Math.PI * 2); g.fill(); } // vias
    g.fillStyle = 'rgba(240,240,235,.85)'; g.font = 'bold 18px sans-serif';
    for (let i = 0; i < 14; i++) g.fillText(['R', 'C', 'U', 'D', 'J', 'GP', 'GND', '3V3'][Math.floor(r() * 8)] + Math.floor(r() * 30), r() * w, r() * h);
    g.strokeStyle = 'rgba(240,240,235,.6)'; g.lineWidth = 2;
    for (let i = 0; i < 10; i++) g.strokeRect(r() * w, r() * h, 20 + r() * 50, 12 + r() * 30);
  });
}
/** Fine noise for plastic roughness (stops surfaces looking like perfect CG). */
const noiseTex = () => canvasTex('noise', 256, 256, (g, w, h) => { const d = g.createImageData(w, h), r = rnd(7); for (let i = 0; i < d.data.length; i += 4) { const v = 150 + r() * 70; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); }, false);
/** Brushed metal: long streaks in the roughness. */
const brushedTex = () => canvasTex('brushed', 512, 64, (g, w, h) => { const r = rnd(3); g.fillStyle = '#777'; g.fillRect(0, 0, w, h); for (let i = 0; i < 400; i++) { const v = 90 + r() * 90; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, r() * h, w, 0.6 + r()); } }, false);
/** 3D-print layer lines as a bump map. */
const layersTex = () => canvasTex('layers', 16, 256, (g, w, h) => { for (let y = 0; y < h; y++) { const v = 128 + Math.sin(y * Math.PI / 2) * 70; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, w, 1); } }, false);
/** Tyre tread blocks as a bump map (wraps around the tyre). */
const treadTex = () => canvasTex('tread', 256, 64, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; for (let x = 0; x < w; x += 16) { g.fillRect(x, 0, 5, h * 0.45); g.fillRect(x + 8, h * 0.55, 5, h * 0.45); } g.fillRect(0, h * 0.47, w, 3); }, false);
function labelTex(text: string, bg: string, fg = '#fff') {
  return canvasTex(`label${text}${bg}`, 256, 96, (g, w, h) => { g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = fg; g.font = 'bold 40px "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 - 8); g.font = '18px Arial'; g.fillText('DIGITAL SERVO', w / 2, h / 2 + 26); });
}

// ------------------------------------------------------------------ materials
const matCache = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material) { if (!matCache.has(key)) matCache.set(key, make()); return matCache.get(key)!; }
export const M = {
  plastic: (c: string, rough = 0.42) => mat(`pl${c}${rough}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: rough, roughnessMap: noiseTex(), clearcoat: 0.15, clearcoatRoughness: 0.4 })),
  printed: (c: string) => mat(`pr${c}`, () => { const t = layersTex(); if (t) { t.repeat.set(1, 6); } return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.62, bumpMap: t, bumpScale: 0.6, sheen: 0.2 }); }),
  rubber: (c = '#1c1d20') => mat(`ru${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.92, roughnessMap: noiseTex() })),
  tread: () => mat('tread', () => { const t = treadTex(); if (t) t.repeat.set(6, 1); return new THREE.MeshPhysicalMaterial({ color: '#17181a', roughness: 0.9, bumpMap: t, bumpScale: 2.5 }); }),
  chrome: () => mat('chrome', () => new THREE.MeshPhysicalMaterial({ color: '#e8eaee', metalness: 1, roughness: 0.12 })),
  alu: (c = '#c9ccd2') => mat(`al${c}`, () => { const t = brushedTex(); return new THREE.MeshPhysicalMaterial({ color: c, metalness: 1, roughness: 0.38, roughnessMap: t, anisotropy: 0.7 } as any); }),
  anodised: (c: string) => mat(`an${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.85, roughness: 0.32, roughnessMap: brushedTex(), clearcoat: 0.3 })),
  gold: () => mat('gold', () => new THREE.MeshPhysicalMaterial({ color: '#e2b34b', metalness: 1, roughness: 0.25 })),
  steel: () => mat('steel', () => new THREE.MeshPhysicalMaterial({ color: '#b5b9bf', metalness: 1, roughness: 0.3 })),
  ic: () => mat('ic', () => new THREE.MeshPhysicalMaterial({ color: '#141416', roughness: 0.55, roughnessMap: noiseTex() })),
  pcb: (c: string, seed = 1) => mat(`pcb${c}${seed}`, () => new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: pcbTex(c, seed), roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.25 })),
  pcbEdge: (c: string) => mat(`pce${c}`, () => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c).multiplyScalar(0.7), roughness: 0.6 })),
  label: (t: string, bg: string) => mat(`lb${t}${bg}`, () => new THREE.MeshPhysicalMaterial({ map: labelTex(t, bg), roughness: 0.5, clearcoat: 0.4 })),
  led: (c: string) => mat(`led${c}`, () => Object.assign(new THREE.MeshPhysicalMaterial({ color: c, emissive: c, emissiveIntensity: 0.6, roughness: 0.2, transmission: 0.3 }), { name: 'glow' })),
  mesh: () => mat('mesh', () => new THREE.MeshPhysicalMaterial({ color: '#9fa4ab', metalness: 0.9, roughness: 0.55, map: canvasTex('meshgrid', 64, 64, (g) => { g.fillStyle = '#888'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#222'; for (let y = 0; y < 64; y += 4) for (let x = (y / 4) % 2 * 2; x < 64; x += 4) g.fillRect(x, y, 2, 2); }) })),
  wire: (c: string) => mat(`w${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.5, clearcoat: 0.6 })),
};

// ------------------------------------------------------------------ geometry helpers
interface Piece { g: THREE.BufferGeometry; m: THREE.Material }
class Kit {
  pieces: Piece[] = [];
  add(g: THREE.BufferGeometry, m: THREE.Material, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0]) {
    g.rotateX(rot[0]); g.rotateY(rot[1]); g.rotateZ(rot[2]); g.translate(...pos);
    this.pieces.push({ g, m }); return this;
  }
  box(size: V3, m: THREE.Material, pos: V3 = [0, 0, 0], r = 0.5, rot: V3 = [0, 0, 0]) { const rr = Math.min(r, ...size.map(s => s / 2 - 0.01)); return this.add(rr > 0.05 ? new RoundedBoxGeometry(size[0], size[1], size[2], 3, rr) : new THREE.BoxGeometry(...size), m, pos, rot); }
  /** Cylinder along local Z (diameter d, length l). */
  cyl(d: number, l: number, m: THREE.Material, pos: V3 = [0, 0, 0], seg = 48, rot: V3 = [0, 0, 0]) { return this.add(new THREE.CylinderGeometry(d / 2, d / 2, l, seg).rotateX(Math.PI / 2), m, pos, rot); }
  /** Cylinder along local Y. */
  cylY(d: number, l: number, m: THREE.Material, pos: V3 = [0, 0, 0], seg = 48) { return this.add(new THREE.CylinderGeometry(d / 2, d / 2, l, seg), m, pos); }
  /** Merge pieces that share a material: fewer draw calls. */
  build(): THREE.Group {
    const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const p of this.pieces) { const g = p.g.index ? p.g.toNonIndexed() : p.g; for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); (by.get(p.m) ?? by.set(p.m, []).get(p.m)!).push(g); }
    const out = new THREE.Group();
    for (const [m, gs] of by) out.add(new THREE.Mesh(gs.length > 1 ? mergeGeometries(gs, false)! : gs[0], m));
    return out;
  }
}
/** A rounded profile extruded along Z, with optional holes (lightening holes, screw holes). */
function plate(w: number, h: number, t: number, radius: number, holes: { x: number; y: number; r: number }[] = [], bevel = 0.4) {
  const s = new THREE.Shape(), x0 = -w / 2, y0 = -h / 2, r = Math.min(radius, w / 2 - 0.01, h / 2 - 0.01);
  s.moveTo(x0 + r, y0); s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r); s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r); s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  for (const hl of holes) { const p = new THREE.Path(); p.absarc(hl.x, hl.y, hl.r, 0, Math.PI * 2, true); s.holes.push(p); }
  const b = Math.min(bevel, t / 3);
  return new THREE.ExtrudeGeometry(s, { depth: t - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 24 }).translate(0, 0, -(t - 2 * b) / 2);
}

// ------------------------------------------------------------------ builders
type Builder = (size: V3, color: string, variant: string) => THREE.Group;

/** Hobby servo: case, mounting ears, top cap, splined output shaft (+Y, offset to +X) with a horn, label, cable. */
const servo: Builder = (size, color, variant) => {
  const [w, h, d] = size, k = new Kit(), big = variant !== 'sg90' && variant !== 'mg90s';
  const caseM = M.plastic(color || (big ? '#141518' : '#2457b8'), 0.38);
  const bodyH = h * 0.78, y0 = -h / 2;
  k.box([w * 0.74, bodyH, d], caseM, [0, y0 + bodyH / 2, 0], 1);
  // mounting ears with screw holes
  const earT = Math.max(1.2, h * 0.07), earY = y0 + bodyH * 0.72;
  k.add(plate(w, d * 0.9, earT, 1.2, [{ x: -w * 0.43, y: 0, r: Math.max(0.8, d * 0.08) }, { x: w * 0.43, y: 0, r: Math.max(0.8, d * 0.08) }], 0.3).rotateX(Math.PI / 2), caseM, [0, earY, 0]);
  // top cap (raised) and the gear tower around the shaft
  const sx = w * 0.16;
  k.box([w * 0.7, h * 0.08, d * 0.96], caseM, [0, y0 + bodyH + h * 0.04, 0], 0.8);
  k.cylY(d * 0.62, h * 0.1, caseM, [sx, y0 + bodyH + h * 0.11, 0]);
  // brass/steel output spline and a horn
  k.cylY(d * 0.22, h * 0.08, big ? M.steel() : M.plastic('#f2f2f2', 0.35), [sx, y0 + bodyH + h * 0.18, 0], 18);
  const hornM = M.plastic('#f4f4f2', 0.35), hy = y0 + h - h * 0.03;
  k.box([d * 0.3, h * 0.05, d * 1.25], hornM, [sx, hy, d * 0.15], 0.6);
  k.cylY(d * 0.42, h * 0.05, hornM, [sx, hy, 0]);
  // label on the front face, screws on the bottom
  k.add(new THREE.PlaneGeometry(w * 0.6, bodyH * 0.38), M.label(big ? variant.toUpperCase() : 'SG90', big ? '#1a1b1e' : '#2457b8'), [0, y0 + bodyH * 0.42, d / 2 + 0.05]);
  // 3-wire lead out of the side
  const lead = new THREE.CatmullRomCurve3([new THREE.Vector3(-w * 0.37, y0 + bodyH * 0.2, 0), new THREE.Vector3(-w * 0.55, y0 + bodyH * 0.15, 0), new THREE.Vector3(-w * 0.62, y0 + 1, d * 0.2)]);
  ['#7a4a2a', '#d02c2c', '#f2a23a'].forEach((c, i) => k.add(new THREE.TubeGeometry(lead, 12, Math.max(0.35, d * 0.035), 6), M.wire(c), [0, 0, (i - 1) * Math.max(0.75, d * 0.075)]));
  return k.build();
};

/** Wheel along local Z: treaded rubber tyre, spoked rim, hub. */
const wheel: Builder = (size, color) => {
  const D = Math.max(size[0], size[1]), W = size[2], k = new Kit();
  const tyreT = D * 0.14, R = D / 2;
  // tyre: rounded torus-ish lathe
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (i / 16) * Math.PI; pts.push(new THREE.Vector2(R - tyreT / 2 + Math.cos(a) * tyreT / 2, Math.sin(a) * W / 2 * 0.98)); }
  pts.unshift(new THREE.Vector2(R - tyreT, -W / 2 * 0.9)); pts.push(new THREE.Vector2(R - tyreT, W / 2 * 0.9));
  k.add(new THREE.LatheGeometry(pts, 64).rotateX(Math.PI / 2), M.tread());
  // rim and spokes
  const rimM = M.plastic(color || '#f1c232', 0.4);
  k.cyl(D - tyreT * 1.9, W * 0.8, rimM, [0, 0, 0], 64);
  k.cyl(D - tyreT * 2.3, W * 0.84, M.plastic('#202124', 0.6), [0, 0, 0], 64); // recess
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2, rr = (D / 2 - tyreT * 1.2) / 2; const g = new RoundedBoxGeometry(D * 0.08, D / 2 - tyreT * 1.2, W * 0.55, 2, 0.4); g.translate(0, rr, 0); g.rotateZ(a); k.add(g, rimM); }
  k.cyl(D * 0.22, W * 0.95, rimM, [0, 0, 0], 32);
  k.cyl(D * 0.06, W * 1.02, M.steel(), [0, 0, 0], 16);
  return k.build();
};

/** Yellow TT gear motor: gearbox, motor can along the body, shaft out the side (local X). */
const ttMotor: Builder = (size) => {
  const [w, h, d] = size, k = new Kit(), y = M.plastic('#f2c230', 0.45);
  k.box([w, h * 0.92, d * 0.55], y, [0, 0, d * 0.22], 1.2);
  k.cyl(h * 0.82, d * 0.5, M.alu('#d7d9dd'), [0, 0, -d * 0.24]);
  k.cyl(h * 0.4, 1.2, M.plastic('#2a2b2e'), [0, 0, -d * 0.49]);
  for (const s of [-1, 1]) k.add(new THREE.CylinderGeometry(h * 0.12, h * 0.12, w * 0.3, 6).rotateZ(Math.PI / 2), M.plastic('#f8f8f8', 0.3), [s * w * 0.55, 0, d * 0.3]);
  k.cyl(1.6, 4, M.gold(), [h * 0.2, h * 0.2, -d * 0.52], 8); k.cyl(1.6, 4, M.gold(), [-h * 0.2, h * 0.2, -d * 0.52], 8);
  return k.build();
};

/** Header pins: a black strip with gold pins along X, standing up on +Z. */
function header(k: Kit, n: number, x0: number, y: number, z: number, pitch = 2.54, rows = 1) {
  for (let r = 0; r < rows; r++) {
    k.box([n * pitch, pitch, 2.5], M.plastic('#111214', 0.5), [x0 + (n * pitch) / 2 - pitch / 2, y + r * pitch, z + 1.25], 0.3);
    for (let i = 0; i < n; i++) k.box([0.64, 0.64, 6], M.gold(), [x0 + i * pitch, y + r * pitch, z + 3], 0);
  }
}

/** A development board: rounded PCB in local XY (components on +Z), styled per board family. */
const pcb: Builder = (size, color, variant) => {
  const [w, hh, t] = size, h = hh, k = new Kit(), seed = [...variant].reduce((a, c) => a + c.charCodeAt(0), 0);
  const fam = /pico|2040|xiao|qtpy|feather|zero(?!2)/.test(variant) ? 'rp' : /esp|d1mini|nano esp/.test(variant) ? 'esp' : /uno|nano|promini/.test(variant) ? 'avr' : /pi\d|pi3|zero2w|pi4|pi5/.test(variant) ? 'pi' : 'generic';
  const col = color || ({ rp: '#1f4d34', esp: '#1d2733', avr: '#1b5e8c', pi: '#1f6d3a', generic: '#1f4d34' } as any)[fam];
  const pt = Math.min(1.6, t);
  k.add(plate(w, h, pt, Math.min(3, w * 0.06), mountHoles(w, h, fam), 0.15), M.pcb(col, seed), [0, 0, -t / 2 + pt / 2]);
  const top = -t / 2 + pt;
  if (fam === 'rp') {
    k.box([7, 7, 0.9], M.ic(), [w * 0.05, 0, top + 0.45], 0.2);           // RP2040 QFN
    k.box([4.5, 3.5, 0.8], M.ic(), [w * 0.25, h * 0.1, top + 0.4], 0.2);  // flash
    k.box([8, 6, 3], M.steel(), [-w / 2 + 3.5, 0, top + 1.5], 0.6);        // USB
    k.box([3.5, 3, 1.6], M.plastic('#f5f5f5', 0.4), [-w * 0.25, -h * 0.22, top + 0.8], 0.4); // BOOTSEL
    k.box([1.6, 0.8, 0.5], M.led('#33ff66'), [-w * 0.32, h * 0.3, top + 0.25], 0.1);
    k.box([3, 1.6, 1], M.steel(), [w * 0.32, -h * 0.25, top + 0.5], 0.3);  // crystal
    if (w > 40) { header(k, 20, -w / 2 + 2.5, -h / 2 + 1.5, top - 9); header(k, 20, -w / 2 + 2.5, h / 2 - 1.5, top - 9); } // pins downward for breadboards
  } else if (fam === 'esp') {
    const mw = Math.min(18, w * 0.4), mh = Math.min(25.5, h * 0.95);
    k.box([mh, mw, 0.8], M.pcb('#141518', seed + 1), [w / 2 - mh / 2 - 1, 0, top + 0.4], 0.3); // module
    k.box([mh * 0.62, mw * 0.8, 2.6], M.steel(), [w / 2 - mh * 0.38 - 1.5, 0, top + 2.1], 0.5); // shield can
    k.box([mh * 0.3, mw * 0.85, 0.2], M.gold(), [w / 2 - mh * 0.08, 0, top + 0.95], 0); // antenna trace
    k.box([9, 7.5, 3.2], M.steel(), [-w / 2 + 4, 0, top + 1.6], 0.8); // USB
    for (const s of [-1, 1]) k.box([3.5, 3, 1.6], M.plastic('#2a2b2e', 0.5), [-w * 0.2, s * h * 0.3, top + 0.8], 0.4);
    k.box([5, 5, 1.2], M.ic(), [-w * 0.05, 0, top + 0.6], 0.3);
    if (w > 40) { header(k, Math.floor(w / 2.54) - 1, -w / 2 + 2.5, -h / 2 + 1.5, top - 9); header(k, Math.floor(w / 2.54) - 1, -w / 2 + 2.5, h / 2 - 1.5, top - 9); }
  } else if (fam === 'avr') {
    if (w > 60) {
      k.box([35, 7.6, 3.5], M.ic(), [w * 0.12, -h * 0.18, top + 1.75], 0.3); // DIP ATmega328P
      k.add(new THREE.BoxGeometry(35, 0.4, 0.4), M.steel(), [w * 0.12, -h * 0.18 - 4.4, top + 0.6]);
      k.box([16, 12, 11], M.steel(), [-w / 2 + 6, h * 0.22, top + 5.5], 0.6);  // USB-B
      k.box([13, 9, 11], M.plastic('#111214', 0.5), [-w / 2 + 6.5, -h * 0.35, top + 5.5], 1); // barrel jack
      header(k, 10, -w * 0.12, h / 2 - 2, top); header(k, 8, w * 0.12, h / 2 - 2, top); header(k, 8, -w * 0.25, -h / 2 + 2, top); header(k, 6, w * 0.15, -h / 2 + 2, top);
      k.cyl(6.3, 7, M.alu('#c8ccd0'), [-w * 0.1, -h * 0.35, top + 3.5], 24); k.cyl(6.3, 7, M.alu('#c8ccd0'), [-w * 0.2, -h * 0.35, top + 3.5], 24); // caps
    } else {
      k.box([7, 7, 1], M.ic(), [0, 0, top + 0.5], 0.3); k.box([7, 5, 2.5], M.steel(), [-w / 2 + 3.5, 0, top + 1.25], 0.5);
      header(k, 15, -w / 2 + 2.5, -h / 2 + 1.5, top - 9); header(k, 15, -w / 2 + 2.5, h / 2 - 1.5, top - 9);
    }
  } else if (fam === 'pi') {
    k.box([14, 14, 1.4], M.alu('#b5b8bd'), [-w * 0.05, 0, top + 0.7], 0.5); // SoC heat spreader
    k.box([12, 8, 1], M.ic(), [w * 0.15, -h * 0.25, top + 0.5], 0.3);
    if (w > 70) { k.box([21, 16, 13.5], M.steel(), [w / 2 - 9, -h * 0.28, top + 6.75], 0.6); k.box([17, 13, 15], M.steel(), [w / 2 - 9, h * 0.05, top + 7.5], 0.6); k.box([17, 13, 15], M.steel(), [w / 2 - 9, h * 0.33, top + 7.5], 0.6); }
    header(k, 20, -w / 2 + 7, h / 2 - 3.5, top, 2.54, 2);
  } else {
    k.box([6, 6, 1], M.ic(), [0, 0, top + 0.5], 0.3);
  }
  return k.build();
};
function mountHoles(w: number, h: number, fam: string) {
  if (fam === 'esp' || w < 30) return [];
  const i = Math.min(3.5, w * 0.06), r = 1.1;
  return [{ x: -w / 2 + i, y: -h / 2 + i, r }, { x: w / 2 - i, y: -h / 2 + i, r }, { x: -w / 2 + i, y: h / 2 - i, r }, { x: w / 2 - i, y: h / 2 - i, r }];
}

/** Breakout modules (local XY board, components on +Z). */
const module: Builder = (size, color, variant) => {
  const [w, h, t] = size, k = new Kit(), pt = Math.min(1.6, t), top = -t / 2 + pt;
  const col = color || ({ hcsr04: '#1b3f8a', pca9685: '#1b3f8a', tb6612: '#5a2a7a', l298n: '#b3262f', mpu6050: '#1b3f8a', bec: '#202124' } as any)[variant] || '#1b3f8a';
  k.add(plate(w, h, pt, 1.2, w > 25 ? [{ x: -w / 2 + 2, y: -h / 2 + 2, r: 1 }, { x: w / 2 - 2, y: -h / 2 + 2, r: 1 }, { x: -w / 2 + 2, y: h / 2 - 2, r: 1 }, { x: w / 2 - 2, y: h / 2 - 2, r: 1 }] : [], 0.15), M.pcb(col, w | 0), [0, 0, -t / 2 + pt / 2]);
  if (variant === 'hcsr04') {
    for (const s of [-1, 1]) { k.cyl(16, 12, M.alu('#d9dbdf'), [s * 13, 0, top + 6], 48); k.cyl(13.5, 0.5, M.mesh(), [s * 13, 0, top + 12.1], 48); }
    k.box([11, 4.5, 3.5], M.steel(), [0, h * 0.28, top + 1.75], 0.8); // crystal
    header(k, 4, -3.8, -h / 2 + 1.5, top, 2.54);
  } else if (variant === 'pca9685') {
    k.box([7.8, 4.4, 1.3], M.ic(), [0, -h * 0.15, top + 0.65], 0.2);
    for (let g = 0; g < 4; g++) header(k, 3, -w / 2 + 6 + g * 9.5, h / 2 - 4, top, 2.54, 3); // 16 × 3 servo headers (4 shown groups)
    k.box([8, 5, 8], M.plastic('#1e6fd9', 0.5), [w / 2 - 5, -h * 0.25, top + 4], 0.6); // V+ terminal
    k.cyl(6.3, 8, M.alu('#3a3f46'), [w / 2 - 6, h * 0.0, top + 4], 24); // capacitor
  } else if (variant === 'tb6612' || variant === 'l298n') {
    if (variant === 'l298n') { k.box([w * 0.55, 3, h * 0.5], M.anodised('#202124'), [0, h * 0.15, top + h * 0.25], 0.4, [Math.PI / 2, 0, 0]); for (let i = 0; i < 8; i++) k.box([w * 0.5, 1, 6], M.anodised('#202124'), [0, h * 0.15 + 2, top + 3 + i * 1.6], 0); k.box([10, 8, 9], M.plastic('#1e6fd9', 0.5), [-w / 2 + 6, -h * 0.3, top + 4.5], 0.6); k.box([10, 8, 9], M.plastic('#1e6fd9', 0.5), [w / 2 - 6, -h * 0.3, top + 4.5], 0.6); }
    else { k.box([5, 6, 1], M.ic(), [0, 0, top + 0.5], 0.2); header(k, 8, -w / 2 + 1.5, -h / 2 + 1.3, top); header(k, 8, -w / 2 + 1.5, h / 2 - 1.3, top); }
  } else if (variant === 'mpu6050') {
    k.box([4, 4, 0.9], M.ic(), [0, 0, top + 0.45], 0.2); header(k, 8, -w / 2 + 1.5, -h / 2 + 1.3, top);
  } else if (variant === 'bec') {
    k.box([w, h, t * 0.8], M.plastic('#202124', 0.6), [0, 0, 0], 1.5); k.add(new THREE.PlaneGeometry(w * 0.7, h * 0.5), M.label('5V BEC', '#202124'), [0, 0, t * 0.4 + 0.05]);
  } else {
    k.box([4, 4, 1], M.ic(), [0, 0, top + 0.5], 0.2); header(k, 4, -3.8, -h / 2 + 1.3, top);
  }
  return k.build();
};

/** Two 18650 cells in a black holder (along local Z). */
const battery: Builder = (size) => {
  const [w, h, d] = size, k = new Kit();
  k.box([w, h * 0.6, d], M.plastic('#141518', 0.55), [0, -h * 0.2, 0], 1.2);
  for (const s of [-1, 1]) { k.cyl(Math.min(18, w / 2.3), d * 0.86, M.plastic('#2b6fd6', 0.3), [s * w / 4.2, h * 0.08, 0]); k.cyl(7, d * 0.88, M.steel(), [s * w / 4.2, h * 0.08, 0], 24); }
  return k.build();
};
/** Ball caster: steel ball in a black housing. */
const caster: Builder = (size) => {
  const D = Math.min(size[0], size[2]), k = new Kit();
  k.add(new THREE.SphereGeometry(D / 2, 32, 16), M.chrome());
  k.cylY(D * 1.2, D * 0.45, M.plastic('#141518', 0.5), [0, D * 0.35, 0]);
  return k.build();
};
/** An arm / leg link: brushed or anodised aluminium plate with lightening holes, along local Y. */
const link: Builder = (size, color, variant) => {
  const [w, h, d] = size, k = new Kit(), m = variant === 'printed' ? M.printed(color) : M.anodised(color);
  const holes: { x: number; y: number; r: number }[] = [];
  const n = Math.max(0, Math.floor((h - w * 1.6) / (w * 1.1)));
  for (let i = 0; i < n; i++) holes.push({ x: (-(n - 1) / 2 + i) * w * 1.1, y: 0, r: w * 0.28 });
  // two side plates (a U-channel), joined by a web
  const side = plate(h, w, Math.max(1.2, d * 0.18), w / 2 - 0.2, holes, 0.3).rotateZ(Math.PI / 2);
  k.add(side.clone(), m, [0, 0, d / 2 - Math.max(1.2, d * 0.18) / 2]);
  k.add(side, m, [0, 0, -d / 2 + Math.max(1.2, d * 0.18) / 2]);
  k.box([w * 0.9, h - w, d * 0.5], m, [0, 0, 0], 0.6);
  for (const s of [-1, 1]) k.cyl(w * 0.55, d * 1.04, M.steel(), [0, s * (h / 2 - w / 2), 0], 24); // pivot bosses
  return k.build();
};
/** Rubber foot: a soft ball with a flattened sole. */
const foot: Builder = (size) => { const k = new Kit(); const g = new THREE.SphereGeometry(0.5, 32, 16); g.scale(size[0], size[1], size[2]); k.add(g, M.rubber('#202124')); return k.build(); };
/** A body shell: smooth rounded body with a seam line and a dark top panel. */
const shell: Builder = (size, color) => {
  const [w, h, d] = size, k = new Kit(), r = Math.min(w, h, d) * 0.22;
  k.add(new RoundedBoxGeometry(w, h, d, 6, r), M.plastic(color, 0.35));
  k.add(new RoundedBoxGeometry(w * 0.6, 1, d * 0.62, 3, 0.45), M.plastic('#1a1b1e', 0.5), [0, h / 2 + 0.2, 0]);
  k.add(new RoundedBoxGeometry(w + 0.6, h * 0.06, d + 0.6, 3, h * 0.03), M.plastic('#2a2b2e', 0.6), [0, -h * 0.05, 0]);
  return k.build();
};
/** A robot head / sensor pod with two camera "eyes". */
const head: Builder = (size, color) => {
  const [w, h, d] = size, k = new Kit();
  k.add(new RoundedBoxGeometry(w, h, d, 6, Math.min(w, h, d) * 0.3), M.plastic(color || '#1a1b1e', 0.3));
  for (const s of [-1, 1]) { k.cyl(h * 0.36, 2, M.chrome(), [s * w * 0.22, h * 0.05, d / 2], 32); k.cyl(h * 0.24, 2.4, M.led('#3aa0ff'), [s * w * 0.22, h * 0.05, d / 2 + 0.2], 32); }
  return k.build();
};
/** A turntable / round base with a bearing ring. */
const turntable: Builder = (size, color) => {
  const D = Math.max(size[0], size[1]), L = size[2], k = new Kit();
  k.cyl(D, L * 0.7, M.anodised(color || '#d9dde3'), [0, 0, -L * 0.15], 72);
  k.cyl(D * 0.86, L * 0.3, M.steel(), [0, 0, L * 0.35], 72);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.cyl(2.6, L * 1.02, M.steel(), [Math.cos(a) * D * 0.38, Math.sin(a) * D * 0.38, 0], 12); }
  return k.build();
};
/** A base plate with screws at the corners. */
const baseplate: Builder = (size, color) => {
  const [w, h, d] = size, k = new Kit();
  k.box([w, h, d], M.anodised(color || '#2a2d33'), [0, 0, 0], Math.min(6, w * 0.05));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cylY(5, h * 1.05, M.steel(), [sx * (w / 2 - 8), 0.1, sz * (d / 2 - 8)], 16);
  return k.build();
};
/** A gripper finger with teeth on its inner face (+X side faces in). */
const finger: Builder = (size, color) => {
  const [w, h, d] = size, k = new Kit();
  k.box([w, h, d], M.anodised(color || '#9aa1ab'), [0, 0, 0], 0.6);
  for (let i = 0; i < 5; i++) k.box([w * 0.4, h * 0.06, d * 0.9], M.rubber(), [0, h / 2 - h * 0.1 - i * h * 0.12, 0], 0.2);
  return k.build();
};

const BUILDERS: Record<string, Builder> = { servo, wheel, motor: ttMotor, pcb, module, battery, caster, link, foot, shell, head, turntable, baseplate, finger };
export const DETAIL_KINDS = Object.keys(BUILDERS);

/** Build a detailed model for "kind:variant" at `size`, or null if unknown (falls back to the plain shape). */
export function buildDetail(detail: string, size: V3, color: string): THREE.Group | null {
  const [kind, variant = ''] = detail.split(':');
  const b = BUILDERS[kind];
  if (!b) return null;
  try { return b(size.map(v => Math.max(0.5, v)) as V3, color, variant); } catch (e) { console.warn('detail', detail, e); return null; }
}

/** Which detailed model an electronics part uses inside a product (auto build, robots). */
export function detailForComp(type: string): string | null {
  if (type === 'servo') return 'servo:sg90';
  if (type === 'mg996r') return 'servo:mg996r';
  if (['hcsr04', 'pca9685', 'tb6612', 'l298n', 'mpu6050', 'bec', 'sht40', 'aht20', 'bh1750', 'oled'].includes(type)) return `module:${type}`;
  return null;
}
