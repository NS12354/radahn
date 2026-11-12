import * as THREE from 'three';
import { Product, type Role } from './product';

/**
 * Stand-in product for a blank project: nothing in the scene, nothing to pick.
 * The screen canvas still exists so firmware that drives a display has a target.
 */
export class EmptyProduct extends Product {
  pickables(): THREE.Object3D[] { return []; }
  roleOf(): Role { return 'body'; }
  partOf() { return ''; }
  dialCenter() { return new THREE.Vector3(); }
  protected applyDial() {}
  protected applyLeds() {}
  protected applyPress() {}
  dispose() { this.group.clear(); this.screenTex.dispose(); }
}
