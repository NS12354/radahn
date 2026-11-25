/**
 * Move any object in a robot's world by dragging it in the 3D view (Shift-drag turns it).
 * While dragging only the mesh moves; the project's world is updated once, on release,
 * so the robot sim and physics rebuild once rather than every frame.
 */
import * as THREE from 'three';
import type { App } from './app';
import { toast } from './dom';
import { BuiltProduct } from '../scene/built';
import { firmwareRunning } from './elec';
import { crashActive } from './crash';
import { track } from './track';
import { selectWorldObject } from './worldedit';

let drag: { prod: BuiltProduct; i: number; mesh: THREE.Object3D; start: THREE.Vector3; pos: [number, number]; rot: number; x0: number; turn: boolean; now: { pos: [number, number]; rot: number } } | null = null;
const ray = new THREE.Raycaster();

/** Where the pointer meets the floor, in the model's mm space. */
export function floorAt(A: App, prod: BuiltProduct, e: { clientX: number; clientY: number }) {
  const r = A.viewport.renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), A.viewport.camera);
  prod.mm.updateWorldMatrix(true, false);
  const origin = prod.mm.localToWorld(new THREE.Vector3(0, 0, 0)), up = new THREE.Vector3(0, 1, 0).transformDirection(prod.mm.matrixWorld);
  const p = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(up, origin), new THREE.Vector3());
  return p ? prod.mm.worldToLocal(p) : null;
}

export const worldDragging = () => !!drag;

/** Pointer down on the canvas: start dragging a world object if one was hit. Returns true when it took the pointer. */
export function worldDragStart(A: App, e: PointerEvent): boolean {
  const prod = A.product, world = A.project.product.built?.robot?.world;
  if (e.button !== 0 || !(prod instanceof BuiltProduct) || !world || crashActive() || document.body.classList.contains('present')) return false;
  const objs = prod.worldObjects(); if (!objs.length) return false;
  const hit = A.viewport.hit(e, [...prod.pickables(), ...objs]);
  const i = hit?.object.userData.obstacle as number | undefined;
  if (!hit || i === undefined || !world.obstacles[i]) return false; // the robot itself, or empty space: not ours
  selectWorldObject(i); // its move/turn/resize handles appear
  if (firmwareRunning()) { toast('Stop the code to move things in the world'); return true; }
  const start = floorAt(A, prod, e); if (!start) return false;
  const o = world.obstacles[i];
  drag = { prod, i, mesh: hit.object, start, pos: [...o.pos] as [number, number], rot: o.rot ?? 0, x0: e.clientX, turn: e.shiftKey, now: { pos: [...o.pos] as [number, number], rot: o.rot ?? 0 } };
  prod.draggingObj = i;
  A.viewport.controls.enabled = false;
  const move = (ev: PointerEvent) => {
    if (!drag) return;
    const ob = world.obstacles[drag.i];
    if (drag.turn) drag.now.rot = Math.round((drag.rot - (ev.clientX - drag.x0) * 0.6) % 360);
    else {
      const p = floorAt(A, drag.prod, ev); if (!p) return;
      const half = world.size / 2 - Math.max(ob.size[0], ob.size[2]) / 2;
      drag.now.pos = [Math.round(Math.max(-half, Math.min(half, drag.pos[0] + p.x - drag.start.x))), Math.round(Math.max(-half, Math.min(half, drag.pos[1] + p.z - drag.start.z)))];
    }
    drag.mesh.position.set(drag.now.pos[0], ob.size[1] / 2, drag.now.pos[1]);
    drag.mesh.quaternion.setFromEuler(new THREE.Euler(0, drag.now.rot * Math.PI / 180, 0));
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    if (!drag) return;
    const d = drag; drag = null; d.prod.draggingObj = null; A.viewport.controls.enabled = true;
    const ob = world.obstacles[d.i];
    if (!ob || (d.now.pos[0] === d.pos[0] && d.now.pos[1] === d.pos[1] && d.now.rot === d.rot)) return;
    ob.pos = d.now.pos; ob.rot = d.now.rot;
    A.changed('product');
    track('model', `Robot world: moved the ${(ob.name ?? (ob.shape === 'cyl' ? 'cylinder' : 'box')).toLowerCase()}`);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  return true;
}
