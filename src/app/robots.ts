/**
 * Robot templates: a complete project for each kind of robot. The 3D parts and
 * their joints, the electronics wired to drive them, the world it lives in,
 * and the firmware. Geometry is in mm, Y up, the robot facing +Z.
 */
import type { BuiltPart, Joint, Project, RobotSpec, World } from './project';
import { blankProject, defaultAutoOpts, newUid, nextColor } from './project';
import { BOARDS } from '../hw/library/boards';
import type { BoardDef, CompInstance } from '../hw/types';
import { ROBOT_LIBS, ROBOT_MAIN } from '../hw/robotcode';
import { PART_LIBS } from '../hw/partcode';

export type RobotKind = 'arm' | 'rover-avoid' | 'rover-line' | 'dog' | 'hexapod';
export const ROBOT_KINDS: { id: RobotKind; name: string; blurb: string }[] = [
  { id: 'arm', name: 'Robot arm', blurb: '4 axes + gripper, PCA9685, inverse kinematics, teach mode' },
  { id: 'rover-avoid', name: 'Obstacle-avoiding rover', blurb: '2WD, TB6612, sonar, encoders, in a room with obstacles' },
  { id: 'rover-line', name: 'Line follower', blurb: '2WD, two IR line sensors, on a track' },
  { id: 'dog', name: 'Robot dog', blurb: '12 servos, creep gait, IMU balance' },
  { id: 'hexapod', name: 'Hexapod', blurb: '18 servos on two PCA9685s, tripod gait' },
];

type V3 = [number, number, number];
function builder() {
  const parts: BuiltPart[] = [];
  const add = (name: string, shape: BuiltPart['shape'], size: V3, pos: V3, o: Partial<BuiltPart> = {}): BuiltPart => {
    const p: BuiltPart = { id: newUid(), name, shape, size, pos, rot: [0, 0, 0], color: '#d9dde3', finish: 'satin', role: 'body', layer: 0, ...o };
    parts.push(p); return p;
  };
  const joint = (type: Joint['type'], pivot: V3, axis: V3, o: Partial<Joint> = {}): Joint => ({ type, pivot, axis, ...o });
  return { parts, add, joint };
}
const comp = (type: string, pins: Record<string, number | null>, i: number, props?: Record<string, any>): CompInstance => ({ uid: newUid(), type, pins, color: nextColor(i), ...(props ? { props } : {}) });

const ORANGE = '#ff7a2f', DARK = '#2a2d33', GREY = '#9aa1ab', WHITE = '#eceae6', SERVO = '#1c4fa1';

// ------------------------------------------------------------------ arm
function arm(board: BoardDef) {
  const { parts, add, joint } = builder();
  const [sda, scl] = i2cPins(board);
  const pca = comp('pca9685', { SDA: sda, SCL: scl }, 0, { servos: [0, 1, 2, 3].map(ch => ({ ch, type: 'mg996r' })).concat([{ ch: 4, type: 'sg90' }]) });
  const bec = comp('bec', {}, 1, { amps: 10 });
  const drive = (ch: number, o: Partial<NonNullable<Joint['drive']>> = {}) => ({ comp: pca.uid, channel: ch, ...o });
  const base = add('Base plate', 'rbox', [140, 8, 140], [0, 4, 0], { param: 8, color: DARK, detail: 'baseplate' });
  add(board.name, 'box', [51, 21, 5], [-30, 10.5, -52], { rot: [-90, 0, 0], parent: base.id, kind: 'internal', comp: 'board', detail: `pcb:${board.id}` });
  add('PCA9685', 'box', [62, 25, 10], [30, 13, -50], { rot: [-90, 0, 0], parent: base.id, kind: 'internal', comp: pca.uid, detail: 'module:pca9685' });
  add('Servo supply', 'box', [30, 20, 12], [45, 14, 45], { rot: [-90, 0, 0], parent: base.id, kind: 'internal', comp: bec.uid, detail: 'module:bec' });
  const turn = add('Turntable', 'cyl', [80, 80, 12], [0, 14, 0], { rot: [90, 0, 0], color: WHITE, parent: base.id, detail: 'turntable', joint: joint('revolute', [0, 8, 0], [0, 1, 0], { min: -90, max: 90, drive: drive(0) }) });
  const sh = add('Shoulder servo', 'box', [40, 38, 20], [0, 42, 0], { rot: [0, 0, -90], color: '#141518', parent: turn.id, detail: 'servo:mg996r' });
  // links: shoulder (y 45) → elbow 130 mm → wrist 120 mm → gripper tip 75 mm (matches lib/arm.py)
  const upper = add('Upper arm', 'rbox', [26, 136, 22], [0, 110, 0], { param: 4, color: ORANGE, parent: sh.id, detail: 'link', joint: joint('revolute', [0, 45, 0], [1, 0, 0], { min: -90, max: 90, drive: drive(1) }) });
  add('Elbow servo', 'box', [40, 38, 20], [-24, 175, 0], { rot: [0, 0, -90], color: '#141518', parent: upper.id, detail: 'servo:mg996r' });
  const fore = add('Forearm', 'rbox', [22, 124, 20], [0, 235, 0], { param: 4, color: ORANGE, parent: upper.id, detail: 'link', joint: joint('revolute', [0, 175, 0], [1, 0, 0], { min: -120, max: 120, drive: drive(2) }) });
  add('Wrist servo', 'box', [23, 22, 12], [-17, 295, 0], { rot: [0, 0, -90], parent: fore.id, detail: 'servo:mg90s' });
  const wrist = add('Wrist', 'rbox', [22, 40, 22], [0, 310, 0], { param: 3, color: WHITE, parent: fore.id, detail: 'link', joint: joint('revolute', [0, 295, 0], [1, 0, 0], { min: -100, max: 100, drive: drive(3) }) });
  const hand = add('Gripper palm', 'box', [46, 10, 22], [0, 335, 0], { color: DARK, parent: wrist.id, detail: 'baseplate' });
  add('Gripper servo', 'box', [23, 22, 12], [0, 335, -17], { rot: [90, 0, 0], parent: hand.id, detail: 'servo:sg90' });
  add('Gripper finger L', 'box', [6, 36, 14], [17, 358, 0], { color: GREY, parent: hand.id, detail: 'finger', joint: joint('prismatic', [17, 358, 0], [-1, 0, 0], { min: 0, max: 12, drive: drive(4) }) });
  add('Gripper finger R', 'box', [6, 36, 14], [-17, 358, 0], { color: GREY, parent: hand.id, detail: 'finger', joint: joint('prismatic', [-17, 358, 0], [1, 0, 0], { min: 0, max: 12, drive: drive(4) }) });
  return { parts, comps: [pca, bec], spec: { kind: 'arm', mobile: 'fixed', mass: 600, world: armTable() } as RobotSpec, name: 'Robot arm' };
}

/** Where the arm demo picks up (robot's right) and puts down (left), XZ in mm. Matches main.py. */
export const ARM_PICK: [number, number] = [-120, 150];
export const ARM_PLACE: [number, number] = [120, 150];
/**
 * A block the gripper can hold: 20 mm fits between the open fingers (about 27 mm apart),
 * turned to face the base so the fingers close square on it.
 */
export function pickBlock(pos: [number, number] = ARM_PICK, color = '#3aa0ff'): World['obstacles'][number] {
  return { shape: 'box', pos, size: [20, 20, 20], rot: Math.round(Math.atan2(pos[0], pos[1]) * 180 / Math.PI), color, pick: true, name: 'Block' };
}
/** The arm's table: a block to pick up and a green pad to put it on. */
export function armTable(): World {
  return { size: 700, obstacles: [pickBlock(), { shape: 'cyl', pos: ARM_PLACE, size: [60, 4, 60], color: '#33c27f', name: 'Pad' }] };
}

// ------------------------------------------------------------------ rover
function rover(board: BoardDef, mode: 'avoid' | 'line') {
  const { parts, add, joint } = builder();
  const pick = pinPicker(board);
  const drv = comp('tb6612', { PWMA: pick(true), AIN1: pick(), AIN2: pick(), PWMB: pick(true), BIN1: pick(), BIN2: pick() }, 0);
  const comps: CompInstance[] = [drv];
  const chassis = add('Chassis', 'rbox', [130, 5, 180], [0, 36, 0], { param: 10, color: mode === 'avoid' ? ORANGE : '#3aa0ff', detail: 'baseplate' });
  add(board.name, 'box', [51, 21, 5], [0, 41, -30], { rot: [-90, 0, 90], parent: chassis.id, kind: 'internal', comp: 'board', detail: `pcb:${board.id}` });
  add('Motor driver', 'box', [21, 20, 6], [0, 41.5, 25], { rot: [-90, 0, 0], parent: chassis.id, kind: 'internal', comp: drv.uid, detail: 'module:tb6612' });
  add('Battery (2×18650)', 'box', [42, 22, 78], [0, 22, -10], { parent: chassis.id, kind: 'internal', detail: 'battery' });
  const wheel = (side: 1 | -1, ch: number) => {
    add(`TT motor ${side > 0 ? 'L' : 'R'}`, 'box', [22, 19, 64], [side * 48, 28, 30], { color: '#e8c33b', parent: chassis.id, detail: 'motor' });
    const enc = comp('encoder_wheel', { OUT: pick() }, comps.length);
    comps.push(enc);
    const w = add(`Wheel ${side > 0 ? 'L' : 'R'}`, 'cyl', [66, 66, 26], [side * 78, 33, 30], { rot: [0, 90, 0], color: '#f1c232', finish: 'soft', parent: chassis.id, detail: 'wheel', joint: joint('wheel', [side * 78, 33, 30], [1, 0, 0], { drive: { comp: drv.uid, channel: ch }, sensors: [enc.uid] }) });
    void w;
  };
  wheel(1, 0); wheel(-1, 1);
  add('Caster', 'sphere', [20, 33, 20], [0, 16.5, -68], { color: GREY, parent: chassis.id, detail: 'caster' });
  let world: World;
  if (mode === 'avoid') {
    const sonar = comp('hcsr04', { TRIG: pick(), ECHO: pick() }, comps.length); comps.push(sonar);
    add('Ultrasonic sensor', 'box', [45, 20, 14], [0, 52, 88], { parent: chassis.id, kind: 'internal', comp: sonar.uid, detail: 'module:hcsr04' });
    world = { size: 2200, obstacles: [
      { shape: 'box', pos: [0, 600], size: [400, 120, 120] }, { shape: 'cyl', pos: [-550, -200], size: [180, 200, 180], color: '#3aa0ff' },
      { shape: 'box', pos: [600, -300], size: [160, 150, 360], color: '#33c27f' }, { shape: 'box', pos: [-450, 650], size: [200, 100, 200], color: '#e5c07b' },
      { shape: 'cyl', pos: [350, 250], size: [120, 160, 120], color: '#c678dd' },
    ] };
  } else {
    for (const side of [1, -1] as const) {
      const l = comp('line', { OUT: pick() }, comps.length); comps.push(l);
      add(`Line sensor ${side > 0 ? 'L' : 'R'}`, 'box', [10, 3, 14], [side * 9, 8, 80], { rot: [90, 0, 0], parent: chassis.id, kind: 'internal', comp: l.uid, detail: 'module:tcrt5000' });
    }
    const pts: [number, number][] = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([Math.round(Math.cos(a) * 420 - 420), Math.round(Math.sin(a) * 650 + Math.sin(a * 2) * 120)]); }
    world = { size: 2000, obstacles: [], track: { points: pts, width: 26 } };
  }
  // start on the track, facing along it
  return { parts, comps, spec: { kind: 'rover', mobile: 'wheels', mass: 450, world, physics: true } as RobotSpec, name: mode === 'avoid' ? 'Obstacle-avoiding rover' : 'Line follower' };
}

// ------------------------------------------------------------------ legs
function dog(board: BoardDef) {
  const { parts, add, joint } = builder();
  const [sda, scl] = i2cPins(board);
  const pca = comp('pca9685', { SDA: sda, SCL: scl }, 0, { servos: Array.from({ length: 12 }, (_, ch) => ({ ch, type: 'ds3218' })) });
  const imu = comp('mpu6050', { SDA: sda, SCL: scl }, 1);
  const bec = comp('bec', {}, 2, { amps: 15 });
  const H = 160;
  const body = add('Body', 'rbox', [104, 44, 220], [0, H, 0], { param: 10, color: WHITE, detail: 'shell' });
  add('Head', 'rbox', [70, 40, 34], [0, H + 6, 124], { param: 10, color: DARK, parent: body.id, detail: 'head' });
  add(board.name, 'box', [55, 28, 5], [0, H + 8, -40], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: 'board', detail: `pcb:${board.id}` });
  add('PCA9685', 'box', [62, 25, 10], [0, H + 8, 25], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: pca.uid, detail: 'module:pca9685' });
  add('MPU-6050', 'box', [21, 16, 3], [0, H - 4, 60], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: imu.uid, detail: 'module:mpu6050' });
  add('Battery', 'box', [40, 22, 90], [0, H - 9, -10], { parent: body.id, kind: 'internal', detail: 'battery' });
  // legs FL, FR, BL, BR → channels 0-2, 3-5, 6-8, 9-11
  [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([side, front], i) => {
    const x0 = side * 52, z = front * 80, x1 = side * 64, ch = i * 3, nm = `${front > 0 ? 'F' : 'B'}${side > 0 ? 'L' : 'R'}`;
    const d = (k: number, invert = false) => ({ comp: pca.uid, channel: ch + k, invert });
    const hip = add(`${nm} shoulder`, 'box', [40, 38, 20], [x0, H, z], { rot: [90, 0, 90], color: '#141518', parent: body.id, detail: 'servo:ds3218', joint: joint('revolute', [x0, H, z], [0, 0, 1], { min: -40, max: 40, drive: d(0, side < 0) }) });
    const up = add(`${nm} upper leg`, 'rbox', [14, 86, 22], [x1, H - 40, z], { param: 4, color: ORANGE, parent: hip.id, detail: 'link', joint: joint('revolute', [x1, H, z], [1, 0, 0], { min: -80, max: 80, drive: d(1, true) }) });
    const low = add(`${nm} lower leg`, 'rbox', [12, 78, 16], [x1, H - 120 + 4, z], { param: 4, color: DARK, parent: up.id, detail: 'link', joint: joint('revolute', [x1, H - 80, z], [1, 0, 0], { min: -10, max: 150, drive: d(2) }) });
    add(`${nm} foot`, 'sphere', [18, 14, 18], [x1, 7, z], { color: '#1d1f23', finish: 'soft', parent: low.id, foot: true, detail: 'foot' });
  });
  return { parts, comps: [pca, imu, bec], spec: { kind: 'legs', mobile: 'legs', mass: 1300, world: { size: 3000, obstacles: [] }, physics: true } as RobotSpec, name: 'Robot dog' };
}

function hexapod(board: BoardDef) {
  const { parts, add, joint } = builder();
  const [sda, scl] = i2cPins(board);
  const L = comp('pca9685', { SDA: sda, SCL: scl }, 0, { address: 0x40, servos: Array.from({ length: 9 }, (_, ch) => ({ ch, type: 'mg996r' })) });
  const R = comp('pca9685', { SDA: sda, SCL: scl }, 1, { address: 0x41, servos: Array.from({ length: 9 }, (_, ch) => ({ ch, type: 'mg996r' })) });
  const bec = comp('bec', {}, 2, { amps: 20 });
  const H = 100, C = 30, F = 60, T = 100;
  const body = add('Body', 'rbox', [120, 36, 220], [0, H, 0], { param: 14, color: '#33c27f', detail: 'shell' });
  add('Head', 'rbox', [60, 26, 26], [0, H + 4, 118], { color: DARK, parent: body.id, detail: 'head' });
  add(board.name, 'box', [55, 28, 5], [0, H + 8, 0], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: 'board', detail: `pcb:${board.id}` });
  add('PCA9685 L', 'box', [62, 25, 10], [0, H + 8, 55], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: L.uid, detail: 'module:pca9685' });
  add('PCA9685 R', 'box', [62, 25, 10], [0, H + 8, -55], { rot: [-90, 0, 0], parent: body.id, kind: 'internal', comp: R.uid, detail: 'module:pca9685' });
  add('Battery', 'box', [44, 20, 90], [0, H - 8, 0], { parent: body.id, kind: 'internal', detail: 'battery' });
  // L1 L2 L3 (front → back) on PCA L, R1 R2 R3 on PCA R
  [[1, 1], [1, 0], [1, -1], [-1, 1], [-1, 0], [-1, -1]].forEach(([side, row], i) => {
    const drv = side > 0 ? L : R, ch = (i % 3) * 3, z = row * 85, x0 = side * 60, nm = `${side > 0 ? 'L' : 'R'}${(i % 3) + 1}`;
    const d = (k: number, invert: boolean) => ({ comp: drv.uid, channel: ch + k, invert });
    const coxa = add(`${nm} coxa`, 'box', [C + 10, 34, 18], [x0 + side * C / 2, H - 4, z], { color: '#141518', parent: body.id, detail: 'servo:mg996r', joint: joint('revolute', [x0, H, z], [0, 1, 0], { min: -45, max: 45, drive: d(0, side > 0) }) });
    const xf = x0 + side * C;
    const femur = add(`${nm} femur`, 'rbox', [14, F, 18], [xf + side * F / 2, H, z], { rot: [0, 0, 90], param: 4, color: '#33c27f', parent: coxa.id, detail: 'link', joint: joint('revolute', [xf, H, z], [0, 0, 1], { min: -60, max: 80, drive: d(1, side < 0) }) });
    const xt = xf + side * F;
    add(`${nm} knee servo`, 'box', [30, 28, 14], [xt, H + 2, z], { rot: [90, 0, 0], color: '#141518', parent: femur.id, detail: 'servo:mg996r' });
    const tibia = add(`${nm} tibia`, 'rbox', [12, T - 10, 14], [xt, H - (T - 10) / 2, z], { param: 4, color: DARK, parent: femur.id, detail: 'link', joint: joint('revolute', [xt, H, z], [0, 0, 1], { min: -70, max: 70, drive: d(2, side < 0) }) });
    add(`${nm} foot`, 'sphere', [14, 12, 14], [xt, 6, z], { color: '#1d1f23', finish: 'soft', parent: tibia.id, foot: true, detail: 'foot' });
  });
  return { parts, comps: [L, R, bec], spec: { kind: 'legs', mobile: 'legs', mass: 1600, world: { size: 3000, obstacles: [] }, physics: true } as RobotSpec, name: 'Hexapod' };
}

// ------------------------------------------------------------------ pins
function i2cPins(b: BoardDef): [number, number] {
  if (b.family === 'pi') return [2, 3];
  const g = b.i2c?.[0];
  const sda = g?.sda?.find(p => !b.strap.includes(p)) ?? b.gpio.find(p => !b.strap.includes(p))!;
  const scl = g?.scl?.find(p => !b.strap.includes(p) && p !== sda) ?? b.gpio.find(p => !b.strap.includes(p) && p !== sda)!;
  return [sda, scl];
}
/** Free pins in order, PWM-capable when asked, skipping boot, input-only, I2C and analog pins where possible. */
function pinPicker(b: BoardDef) {
  const used = new Set<number>(i2cPins(b));
  return (pwm = false): number | null => {
    const ok = (g: number) => !used.has(g) && !b.strap.includes(g) && !b.inputOnly?.includes(g) && !(b.family === 'avr' && g < 2);
    const g = b.gpio.find(x => ok(x) && !b.adc.includes(x) && (!pwm || !b.hwPwm || b.hwPwm.includes(x))) ?? b.gpio.find(ok) ?? null;
    if (g != null) used.add(g);
    return g;
  };
}

// ------------------------------------------------------------------ code
/** Firmware for a robot project, from its current wiring (regenerated while you haven't edited it). */
export function robotFiles(b: BoardDef, kind: string, comps: CompInstance[]): Record<string, string> {
  const pin = (type: string, role: string, nth = 0) => comps.filter(c => c.type === type)[nth]?.pins[role] ?? null;
  const pca = comps.find(c => c.type === 'pca9685');
  const sda = pca?.pins.SDA ?? null, scl = pca?.pins.SCL ?? null;
  if (b.lang === 'arduino') return { 'robot.ino': arduinoRobot(kind, comps) };
  const i2c = b.lang === 'python' ? 'from smbus2 import SMBus\ni2c = SMBus(1)                          # SDA = GPIO2, SCL = GPIO3' : `i2c = I2C(${Math.max(0, b.i2c?.findIndex(g => sda != null && g.sda?.includes(sda)) ?? 0)}, sda=Pin(${sda}), scl=Pin(${scl}), freq=400000)`;
  const fix = (src: string) => (b.lang === 'python' ? src.replace(/^from machine import I2C, Pin\n/m, '').replace(/^from machine import Pin\n/m, 'from gpiozero import DigitalInputDevice\n') : src);
  const libs = (names: string[]) => Object.fromEntries(names.map(n => [n, ROBOT_LIBS[n] ?? Object.assign({}, ...Object.values(PART_LIBS))[n]]));
  if (kind === 'arm') return { 'main.py': fix(ROBOT_MAIN.arm(i2c)), ...libs(['lib/pca9685.py', 'lib/arm.py']) };
  if (kind === 'dog') return { 'main.py': fix(ROBOT_MAIN.dog(i2c)), ...libs(['lib/pca9685.py', 'lib/legs.py', 'lib/mpu6050.py']) };
  if (kind === 'hexapod') return { 'main.py': fix(ROBOT_MAIN.hexapod(i2c)), ...libs(['lib/pca9685.py', 'lib/legs.py']) };
  const d = comps.find(c => c.type === 'tb6612')?.pins ?? {};
  const mode = kind === 'rover-line' ? 'line' : 'avoid';
  let main = ROBOT_MAIN.rover({ ...d, TRIG: pin('hcsr04', 'TRIG'), ECHO: pin('hcsr04', 'ECHO'), LINE_L: pin('line', 'OUT', 0), LINE_R: pin('line', 'OUT', 1) }, mode);
  if (b.lang === 'python') main = main.replace(/^from machine import Pin\n/m, 'from gpiozero import DigitalInputDevice\n').replace(/Pin\((\d+|None), Pin\.IN\)/g, 'DigitalInputDevice($1)').replace(/\.value\(\)/g, '.value');
  return { 'main.py': main, ...libs(['lib/rover.py', ...(mode === 'avoid' ? ['lib/hcsr04.py'] : [])]) };
}
function arduinoRobot(kind: string, comps: CompInstance[]) {
  if (kind.startsWith('rover')) {
    const d = comps.find(c => c.type === 'tb6612')?.pins ?? {};
    return `// ${kind === 'rover-line' ? 'Line follower' : 'Obstacle-avoiding rover'} on a TB6612FNG (Arduino C++)
const int PWMA = ${d.PWMA}, AIN1 = ${d.AIN1}, AIN2 = ${d.AIN2}, PWMB = ${d.PWMB}, BIN1 = ${d.BIN1}, BIN2 = ${d.BIN2};
void motor(int pwm, int in1, int in2, float s) { digitalWrite(in1, s > 0); digitalWrite(in2, s < 0); analogWrite(pwm, (int)(fabs(s) * 255)); }
void drive(float l, float r) { motor(PWMA, AIN1, AIN2, l); motor(PWMB, BIN1, BIN2, r); }
void setup() { Serial.begin(115200); int p[] = {PWMA, AIN1, AIN2, PWMB, BIN1, BIN2}; for (int i : p) pinMode(i, OUTPUT); Serial.println("ready"); }
void loop() { drive(0.6, 0.6); delay(1500); drive(-0.5, 0.5); delay(500); }
`;
  }
  return `// Servo robot on a PCA9685 (Arduino C++): sets every servo to its centre, then sweeps channel 0.
#include <Wire.h>
const uint8_t PCA = 0x40;
void reg(uint8_t r, uint8_t v) { Wire.beginTransmission(PCA); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
void servo(uint8_t ch, float deg) { uint16_t off = (500 + deg / 180 * 2000) * 4096 / 20000; Wire.beginTransmission(PCA); Wire.write(0x06 + 4 * ch); Wire.write(0); Wire.write(0); Wire.write(off & 0xFF); Wire.write(off >> 8); Wire.endTransmission(); }
void setup() { Serial.begin(115200); Wire.begin(); reg(0, 0x10); reg(0xFE, 121); reg(0, 0x00); delay(1); reg(0, 0xA0); for (int ch = 0; ch < 16; ch++) servo(ch, 90); Serial.println("ready"); }
void loop() { for (int a = 60; a <= 120; a += 2) { servo(0, a); delay(20); } for (int a = 120; a >= 60; a -= 2) { servo(0, a); delay(20); } }
`;
}

/** Board each robot starts on: real MicroPython on the emulated Pico for the arm and rovers, the faster behavioral ESP32 for walkers. */
const DEFAULT_BOARD: Record<RobotKind, string> = { arm: 'picow', 'rover-avoid': 'picow', 'rover-line': 'picow', dog: 'esp32', hexapod: 'esp32' };

export function robotProject(kind: RobotKind, boardId = DEFAULT_BOARD[kind]): Project {
  const b = BOARDS[boardId];
  const r = kind === 'arm' ? arm(b) : kind === 'dog' ? dog(b) : kind === 'hexapod' ? hexapod(b) : rover(b, kind === 'rover-line' ? 'line' : 'avoid');
  const p = blankProject(boardId);
  const files = robotFiles(b, kind, r.comps);
  p.name = r.name;
  p.product = { ...p.product, source: 'built', built: { parts: r.parts, xray: false, auto: defaultAutoOpts(), notes: [`${r.name}: joints are driven by the electronics. Run the firmware, or move them in the Robot panel.`], robot: r.spec } };
  p.electronics = { board: boardId, comps: r.comps, files, activeFile: 'main.py' in files ? 'main.py' : Object.keys(files)[0], filesEdited: false, starter: 'robot', robot: kind };
  return p;
}
