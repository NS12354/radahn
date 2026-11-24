/**
 * ROS 2 bridge over rosbridge (rosbridge_suite's WebSocket JSON protocol).
 *
 * On the ROS side:   ros2 launch rosbridge_server rosbridge_websocket_launch.xml
 * Publishes  /joint_states        sensor_msgs/msg/JointState   (names = the exported URDF's joints; radians / metres)
 *            /formframe/pose      geometry_msgs/msg/PoseStamped (mobile robots: the body in the world, ROS axes)
 * Subscribes /cmd_vel             geometry_msgs/msg/Twist      (wheeled robots: drive while no firmware is running)
 *            /formframe/joint_commands sensor_msgs/msg/JointState (move joints by name, while no firmware drives them)
 * With robot_state_publisher fed the URDF from "Export URDF", RViz shows the robot moving live.
 */
import * as THREE from 'three';
import type { RobotSim } from './robot';
import { urdfJointNames } from './urdf';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'error';

export class RosBridge {
  status: BridgeStatus = 'off';
  error = '';
  rx = 0; tx = 0;
  onStatus: (s: BridgeStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private timer: any = null;

  constructor(private sim: () => RobotSim | null, private WS: typeof WebSocket = globalThis.WebSocket) {}

  connect(url: string) {
    this.close();
    this.set('connecting');
    let ws: WebSocket;
    try { ws = new this.WS(url); } catch (e: any) { this.error = e.message; this.set('error'); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.send({ op: 'advertise', topic: '/joint_states', type: 'sensor_msgs/msg/JointState' });
      this.send({ op: 'advertise', topic: '/formframe/pose', type: 'geometry_msgs/msg/PoseStamped' });
      this.send({ op: 'subscribe', topic: '/cmd_vel', type: 'geometry_msgs/msg/Twist' });
      this.send({ op: 'subscribe', topic: '/formframe/joint_commands', type: 'sensor_msgs/msg/JointState' });
      this.set('connected');
      this.timer = setInterval(() => this.publish(), 50);
    };
    ws.onmessage = e => { this.rx++; try { this.receive(JSON.parse(String(e.data))); } catch { /* not JSON */ } };
    ws.onerror = () => { this.error = `Can't reach rosbridge at ${url}. Is rosbridge_server running?`; this.set('error'); };
    ws.onclose = () => { clearInterval(this.timer); if (this.status !== 'error') this.set('off'); };
  }
  close() { clearInterval(this.timer); this.ws?.close(); this.ws = null; if (this.status !== 'off') this.set('off'); }

  private set(s: BridgeStatus) { this.status = s; this.onStatus(s); }
  private send(o: unknown) { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(o)); this.tx++; } }

  /** One /joint_states (+ pose) message from the simulator. */
  publish() {
    const sim = this.sim(); if (!sim) return;
    const names = urdfJointNames(sim.model), now = Date.now();
    const stamp = { sec: Math.floor(now / 1000), nanosec: (now % 1000) * 1e6 };
    const js = sim.joints.filter(j => names.has(j.id));
    this.send({ op: 'publish', topic: '/joint_states', msg: {
      header: { stamp, frame_id: '' }, name: js.map(j => names.get(j.id)),
      position: js.map(j => (j.joint.type === 'prismatic' ? j.q / 1000 : (j.q * Math.PI) / 180)), velocity: [], effort: [],
    } });
    if (sim.spec?.mobile && sim.spec.mobile !== 'fixed') {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); sim.body.m.decompose(p, q, s);
      // Formframe (x, y, z) → ROS (z, x, y); quaternion axes permute the same way
      this.send({ op: 'publish', topic: '/formframe/pose', msg: { header: { stamp, frame_id: 'odom' }, pose: { position: { x: p.z / 1000, y: p.x / 1000, z: p.y / 1000 }, orientation: { x: q.z, y: q.x, z: q.y, w: q.w } } } });
    }
  }

  receive(m: any) {
    const sim = this.sim(); if (!sim || m?.op !== 'publish') return;
    if (m.topic === '/cmd_vel') sim.cmdVel = { v: (m.msg?.linear?.x ?? 0) * 1000, w: m.msg?.angular?.z ?? 0, t: performance.now() };
    if (m.topic === '/formframe/joint_commands') {
      const byName = new Map([...urdfJointNames(sim.model)].map(([id, n]) => [n, id]));
      (m.msg?.name ?? []).forEach((n: string, i: number) => {
        const id = byName.get(n), v = m.msg.position?.[i];
        const j = sim.joints.find(x => x.id === id);
        if (j && typeof v === 'number') sim.manual.set(j.id, j.joint.type === 'prismatic' ? v * 1000 : (v * 180) / Math.PI);
      });
    }
  }
}
