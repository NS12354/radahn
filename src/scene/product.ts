import * as THREE from 'three';
import type { ProductIO } from '../hw/types';

export type Role = 'body' | 'dial' | 'screen' | 'press' | 'led' | 'mount' | 'ignore';

/**
 * Common interface for anything that can be "the product": the built-in
 * parametric thermostat or an imported CAD model with role bindings.
 * Electronics, interactions and review all talk to the product through this.
 */
export abstract class Product implements ProductIO {
  group = new THREE.Group();
  /** 512×512 canvas mapped onto the screen surface. */
  screen: HTMLCanvasElement;
  screenTex: THREE.CanvasTexture;
  protected ledColors: [number, number, number][] | null = null;
  protected pulse = { color: new THREE.Color(0), t: 0 };
  protected pressed = false;
  protected shakeT = 0;
  protected hapticOn = false;
  dialAngle = 0;

  constructor() {
    this.screen = document.createElement('canvas');
    this.screen.width = this.screen.height = 512;
    this.screenTex = new THREE.CanvasTexture(this.screen);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.anisotropy = 4;
  }

  abstract pickables(): THREE.Object3D[];
  abstract roleOf(o: THREE.Object3D): Role;
  /** Design-mode part key for selection (parametric: body/dial/...; imported: mesh path). */
  abstract partOf(o: THREE.Object3D): string;
  /** Centre of the dial in world space (for drag-to-rotate). */
  abstract dialCenter(): THREE.Vector3;
  protected abstract applyDial(): void;
  protected abstract applyLeds(colors: [number, number, number][] | null, pulse: THREE.Color, pulseT: number): void;
  protected abstract applyPress(depth: number): void;
  abstract dispose(): void;
  explode(_t: number) {}
  highlight(_part: string | null) {}

  // ---- ProductIO (driven by electronics)
  screenCanvas() { return this.screen; }
  screenUpdated() { this.screenTex.needsUpdate = true; }
  setLeds(c: [number, number, number][] | null) { this.ledColors = c; }
  haptic(on: boolean) { this.hapticOn = on; }

  // ---- interaction-mode effects
  flashLed(hex: number) { this.pulse.color.setHex(hex); this.pulse.t = 1; }
  shake() { this.shakeT = 1; }
  setPressed(p: boolean) { this.pressed = p; }
  rotateDial(delta: number) { this.dialAngle -= delta; this.applyDial(); }
  resetDial() { this.dialAngle = 0; this.applyDial(); }

  tick(dt: number, now: number) {
    if (this.pulse.t > 0) this.pulse.t = Math.max(0, this.pulse.t - dt * 0.9);
    this.applyLeds(this.ledColors, this.pulse.color, this.pulse.t);
    this.applyPress(this.pressed ? 1 : 0);
    if (this.hapticOn) this.shakeT = Math.max(this.shakeT, 0.6);
    if (this.shakeT > 0) { this.shakeT = Math.max(0, this.shakeT - dt * 7); this.group.position.x = Math.sin(now * 0.12) * 0.025 * this.shakeT; }
    else this.group.position.x = 0;
  }
}
