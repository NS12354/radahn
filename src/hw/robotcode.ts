/**
 * Robot libraries (plain Python that runs in MicroPython on the emulated Pico,
 * in the behavioral sim, on a real board, and on a Raspberry Pi with smbus2).
 * Angle conventions match the joints the robot templates build:
 *  servo angle 90 = the joint's rest pose; see each library's docstring.
 */

export const ROBOT_LIBS: Record<string, string> = {
  'lib/pca9685.py': `"""PCA9685 16-channel servo driver over I2C (MicroPython machine.I2C or smbus2.SMBus).
servos = Servos(i2c)            # 50 Hz
servos.angle(0, 90)             # channel 0 to 90 degrees (500-2500 us)
servos.release(0)               # stop sending pulses"""
import time

class PCA9685:
    def __init__(self, i2c, address=0x40):
        self.i2c = i2c
        self.address = address
        self._w(0x00, 0x00)          # MODE1: wake, normal

    def _w(self, reg, v):
        if hasattr(self.i2c, 'writeto'):
            self.i2c.writeto(self.address, bytearray([reg, v]))
        else:
            self.i2c.write_byte_data(self.address, reg, v)

    def _wn(self, reg, data):
        if hasattr(self.i2c, 'writeto'):
            self.i2c.writeto(self.address, bytearray([reg] + list(data)))
        else:
            self.i2c.write_i2c_block_data(self.address, reg, list(data))

    def freq(self, hz):
        pre = int(25000000 / (4096 * hz) - 0.5)
        self._w(0x00, 0x10)          # sleep (prescale is only writable asleep)
        self._w(0xFE, pre)
        self._w(0x00, 0x00)
        time.sleep_ms(1) if hasattr(time, 'sleep_ms') else time.sleep(0.001)
        self._w(0x00, 0xA0)          # restart + auto-increment
        self.hz = hz

    def pwm(self, ch, on, off):
        self._wn(0x06 + 4 * ch, [on & 0xFF, on >> 8, off & 0xFF, off >> 8])

class Servos:
    def __init__(self, i2c, address=0x40, freq=50, min_us=500, max_us=2500):
        self.pca = PCA9685(i2c, address)
        self.pca.freq(freq)
        self.period = 1000000 / freq
        self.min_us = min_us
        self.max_us = max_us

    def us(self, ch, us):
        self.pca.pwm(ch, 0, int(us * 4096 / self.period))

    def angle(self, ch, deg):
        deg = max(0, min(180, deg))
        self.us(ch, self.min_us + (self.max_us - self.min_us) * deg / 180)

    def release(self, ch):
        self.pca.pwm(ch, 0, 0)
`,

  'lib/arm.py': `"""4-axis robot arm + gripper on a PCA9685, with inverse kinematics.
arm = Arm(servos)
arm.move_to(0, 120, 150)        # gripper tip to x (left), y (up), z (forward) in mm from the base
arm.grip(True)                  # close
Joints (servo channel, 90 degrees = straight up): base 0, shoulder 1, elbow 2, wrist 3, gripper 4.
Positive angles lean the arm forward; the base turns toward +x (the robot's left)."""
import math, time

class Arm:
    L1 = 130      # shoulder -> elbow (mm)
    L2 = 120      # elbow -> wrist
    L3 = 75       # wrist -> gripper tip
    SHOULDER_Y = 45
    CH = (0, 1, 2, 3)
    GRIP = 4

    def __init__(self, servos, speed=90):
        self.s = servos
        self.speed = speed               # degrees per second for smooth moves
        self.q = [0.0, 0.0, 0.0, 0.0]
        self.set_joints(self.q)

    def set_joints(self, q):
        self.q = list(q)
        for ch, a in zip(self.CH, q):
            self.s.angle(ch, 90 + a)

    def ik(self, x, y, z, pitch=-90):
        """Joint angles (deg) that put the gripper tip at (x, y, z), pointing pitch degrees from horizontal."""
        yaw = math.degrees(math.atan2(x, z))
        r = math.sqrt(x * x + z * z)
        h = y - self.SHOULDER_Y
        p = math.radians(pitch)
        rw = r - self.L3 * math.cos(p)
        hw = h - self.L3 * math.sin(p)
        d2 = rw * rw + hw * hw
        c = (d2 - self.L1 ** 2 - self.L2 ** 2) / (2 * self.L1 * self.L2)
        if c > 1 or c < -1:
            raise ValueError('out of reach')
        a2 = math.acos(c)
        a1 = math.atan2(rw, hw) - math.atan2(self.L2 * math.sin(a2), self.L1 + self.L2 * math.cos(a2))
        a3 = math.radians(90 - pitch) - a1 - a2
        return [yaw, math.degrees(a1), math.degrees(a2), math.degrees(a3)]

    def move_joints(self, q, speed=None):
        """Glide to joint angles at speed deg/s (all joints arrive together)."""
        speed = speed or self.speed
        start = list(self.q)
        span = max(abs(b - a) for a, b in zip(start, q))
        steps = max(1, int(span / speed * 50))
        for i in range(1, steps + 1):
            t = i / steps
            t = t * t * (3 - 2 * t)          # ease in/out
            self.set_joints([a + (b - a) * t for a, b in zip(start, q)])
            time.sleep(0.02)

    def move_to(self, x, y, z, pitch=-90, speed=None):
        self.move_joints(self.ik(x, y, z, pitch), speed)

    def grip(self, close=True):
        self.s.angle(self.GRIP, 170 if close else 10)
        time.sleep(0.3)

    def home(self):
        self.move_joints([0, 0, 0, 0])

    def play(self, poses, pause=0.3):
        """Replay poses recorded in Formframe's teach mode: a list of [base, shoulder, elbow, wrist, grip]."""
        for p in poses:
            self.move_joints(p[:4])
            if len(p) > 4:
                self.s.angle(self.GRIP, 90 + p[4])
            time.sleep(pause)
`,

  'lib/rover.py': `"""Two-wheel robot on a TB6612FNG (or L298N) dual motor driver.
bot = Rover(pwma=, ain1=, ain2=, pwmb=, bin1=, bin2=)   # channel A = left wheel, B = right
bot.drive(0.6, 0.6)            # left, right speed -1..1
bot.forward(0.5); bot.turn_left(0.5); bot.stop()"""
try:
    from machine import Pin, PWM

    class _Out:
        def __init__(self, pin, pwm=False):
            self.p = PWM(Pin(pin), freq=1000) if pwm else Pin(pin, Pin.OUT, value=0)
            self.is_pwm = pwm
        def set(self, v):
            if self.is_pwm:
                self.p.duty_u16(int(max(0, min(1, v)) * 65535))
            else:
                self.p.value(1 if v else 0)
except ImportError:                      # Raspberry Pi: gpiozero
    from gpiozero import PWMOutputDevice, DigitalOutputDevice

    class _Out:
        def __init__(self, pin, pwm=False):
            self.p = PWMOutputDevice(pin, frequency=1000) if pwm else DigitalOutputDevice(pin)
            self.is_pwm = pwm
        def set(self, v):
            self.p.value = max(0, min(1, v)) if self.is_pwm else (1 if v else 0)

class _Channel:
    def __init__(self, pwm, in1, in2):
        self.pwm = _Out(pwm, True)
        self.in1 = _Out(in1)
        self.in2 = _Out(in2)
    def speed(self, s):
        self.in1.set(s > 0)
        self.in2.set(s < 0)
        self.pwm.set(abs(s))

class Rover:
    def __init__(self, pwma, ain1, ain2, pwmb, bin1, bin2):
        self.left = _Channel(pwma, ain1, ain2)
        self.right = _Channel(pwmb, bin1, bin2)
    def drive(self, left, right):
        self.left.speed(max(-1, min(1, left)))
        self.right.speed(max(-1, min(1, right)))
    def forward(self, s=0.6):
        self.drive(s, s)
    def backward(self, s=0.6):
        self.drive(-s, -s)
    def turn_left(self, s=0.5):
        self.drive(-s, s)
    def turn_right(self, s=0.5):
        self.drive(s, -s)
    def stop(self):
        self.drive(0, 0)
`,

  'lib/legs.py': `"""Leg inverse kinematics and gaits for walking robots on PCA9685 servo drivers.

Quadruped (robot dog): each leg has abduction (sideways), hip and knee.
  foot target (x outward, y down, z forward) in mm from the leg's abduction pivot.
  angles: abduction + = outward, hip + = upper leg forward, knee + = foot back. 90 deg servo = straight leg.
Hexapod: each leg has coxa (yaw), femur and tibia.
  foot target (x outward, y down, z forward) from the coxa pivot.
  angles: coxa + = forward, femur + = up, tibia + = foot outward. 90 deg servo = femur level, tibia straight down."""
import math, time

def dog_leg_ik(x, y, z, offset=12, L1=80, L2=80):
    L = math.sqrt(max(1, x * x + y * y - offset * offset))
    abd = math.atan2(x, y) - math.atan2(offset, L)
    d = math.sqrt(z * z + L * L)
    c = max(-1, min(1, (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)))
    knee = math.acos(c)
    hip = math.atan2(z, L) + math.atan2(L2 * math.sin(knee), L1 + L2 * math.cos(knee))
    return math.degrees(abd), math.degrees(hip), math.degrees(knee)

def hex_leg_ik(x, y, z, coxa=30, F=60, T=100):
    yaw = math.atan2(z, x)
    r = math.sqrt(x * x + z * z) - coxa
    D = math.sqrt(r * r + y * y)
    a = math.acos(max(-1, min(1, (F * F + D * D - T * T) / (2 * F * D))))
    g = math.acos(max(-1, min(1, (F * F + T * T - D * D) / (2 * F * T))))
    femur = a - math.atan2(y, r)
    tibia = g - math.pi / 2
    return math.degrees(yaw), math.degrees(femur), math.degrees(tibia)

class Legs:
    """legs: list of (servo driver, (ch_a, ch_b, ch_c)); ik: dog_leg_ik or hex_leg_ik.
    sides: +1 for legs on the left, -1 on the right. fronts: +1 front, -1 back, 0 middle."""
    def __init__(self, legs, ik, stance, sides, fronts):
        self.legs = legs
        self.ik = ik
        self.stance = stance            # neutral foot targets [(x out, y down, z forward), ...]
        self.sides = sides
        self.fronts = fronts
        self.feet = [list(p) for p in stance]

    def place(self, i, x, y, z):
        drv, chs = self.legs[i]
        for ch, a in zip(chs, self.ik(x, y, z)):
            drv.angle(ch, 90 + a)

    def apply(self, feet=None):
        feet = feet or self.feet
        for i, f in enumerate(feet):
            self.place(i, f[0], f[1], f[2])

    def stand(self, height=None, steps=25):
        start = [list(f) for f in self.feet]
        goal = [[s[0], height or s[1], s[2]] for s in self.stance]
        for k in range(1, steps + 1):
            t = k / steps
            self.feet = [[a + (b - a) * t for a, b in zip(p, q)] for p, q in zip(start, goal)]
            self.apply()
            time.sleep(0.02)

    def gait(self, groups, stride=40, lift=30, turn=0.0, cycles=4, ticks=24, shift=0.0):
        """Walk: each group of legs swings forward in turn while the rest push back.
        stride: mm per cycle; turn: -1..1 (+ = left); shift: mm to lean the body away from the swinging legs."""
        n = len(groups)
        slot = {}
        for gi, g in enumerate(groups):
            for i in g:
                slot[i] = gi
        for _ in range(cycles):
            for gi, g in enumerate(groups):
                # lean away from the swinging legs (keeps the weight over the others)
                lx = -sum(self.sides[j] for j in g) / len(g) * shift
                lz = -sum(self.fronts[j] for j in g) / len(g) * shift
                for k in range(ticks + 1):
                    t = k / ticks
                    lean = math.sin(math.pi * t)
                    feet = []
                    for i, s in enumerate(self.stance):
                        dz = stride * (1 - turn * self.sides[i])
                        if i in g:
                            z = s[2] - dz / 2 + dz * t
                            y = s[1] - lift * math.sin(math.pi * t)
                        else:
                            ph = (gi - slot.get(i, 0) - 1) % n
                            z = s[2] + dz / 2 - dz * (ph + t) / max(1, n - 1)
                            y = s[1]
                        # body moves by (lx, lz) = feet move the other way; x is outward, so flip by side
                        x = s[0] - self.sides[i] * lx * lean
                        z -= lz * lean
                        feet.append([x, y, z])
                    self.feet = feet
                    self.apply()
                    time.sleep(0.015)
`,
};

/** MicroPython main programs for the robot templates (pins filled in by the template). */
export const ROBOT_MAIN = {
  arm: (i2c: string) => `# Robot arm: 4 axes + gripper on a PCA9685 servo driver.
# Press Run: it homes, then picks a block up on the right and puts it down on the left.
# Teach mode (Robot panel → Record pose) gives you poses to paste into POSES below.
from machine import I2C, Pin
import time
from pca9685 import Servos
from arm import Arm

${i2c}
servos = Servos(i2c)
arm = Arm(servos, speed=120)
print('ready')

POSES = []   # paste recorded poses here: [base, shoulder, elbow, wrist, grip]

arm.grip(False)
arm.home()
while True:
    if POSES:
        arm.play(POSES)
        continue
    arm.move_to(-120, 110, 150)          # above the blue block (robot's right)
    arm.move_to(-120, 40, 150)           # down
    arm.grip(True)
    arm.move_to(-120, 110, 150)          # lift
    arm.move_to(120, 110, 150)           # swing over to the green pad
    arm.move_to(120, 45, 150)            # put it down
    arm.grip(False)
    arm.move_to(120, 110, 150)
    arm.home()
    print('placed')
    time.sleep(0.5)
`,
  rover: (pins: Record<string, number | null>, mode: 'avoid' | 'line') => `# Two-wheel robot: ${mode === 'avoid' ? 'drives around and steers away from obstacles (HC-SR04 sonar).' : 'follows the dark line with two IR line sensors.'}
# Press Run and watch it in the 3D view. The world (obstacles, track) is in the Robot panel.
from machine import Pin
import time
from rover import Rover
${mode === 'avoid' ? 'from hcsr04 import HCSR04\n' : ''}
bot = Rover(pwma=${pins.PWMA}, ain1=${pins.AIN1}, ain2=${pins.AIN2}, pwmb=${pins.PWMB}, bin1=${pins.BIN1}, bin2=${pins.BIN2})
${mode === 'avoid' ? `sonar = HCSR04(trigger_pin=${pins.TRIG}, echo_pin=${pins.ECHO})
print('ready')
turn_left = True
while True:
    try:
        cm = sonar.distance_cm()
    except OSError:
        cm = 400
    if cm < 25:
        print('obstacle at %d cm' % cm)
        bot.backward(0.5)
        time.sleep(0.4)
        if turn_left:
            bot.turn_left(0.6)
        else:
            bot.turn_right(0.6)
        time.sleep(0.5)
        turn_left = not turn_left
    else:
        bot.forward(0.7)
    time.sleep(0.05)
` : `left = Pin(${pins.LINE_L}, Pin.IN)      # HIGH over the dark line
right = Pin(${pins.LINE_R}, Pin.IN)
print('ready')
last = 1
while True:
    l, r = left.value(), right.value()
    if l and r:
        bot.forward(0.55)
    elif l:
        bot.drive(0.0, 0.6)             # line is to the left: turn left
        last = 1
    elif r:
        bot.drive(0.6, 0.0)
        last = -1
    else:
        bot.drive(-0.3 * last, 0.3 * last)   # lost it: spin back toward where it was
    time.sleep(0.01)
`}`,
  dog: (i2c: string) => `# Robot dog: 12 servos (4 legs x abduction, hip, knee) on a PCA9685, MPU-6050 for balance.
# Press Run: it stands up, walks forward with a stable creep gait, turns, then balances.
from machine import I2C, Pin
import time
from pca9685 import Servos
from legs import Legs, dog_leg_ik
from mpu6050 import MPU6050

${i2c}
servos = Servos(i2c)
imu = MPU6050(i2c)
# legs FL, FR, BL, BR: channels (abduction, hip, knee)
LEGS = [(servos, (0, 1, 2)), (servos, (3, 4, 5)), (servos, (6, 7, 8)), (servos, (9, 10, 11))]
HEIGHT = 130
STANCE = [(12, HEIGHT, 0)] * 4          # under each hip
dog = Legs(LEGS, dog_leg_ik, STANCE, sides=[1, -1, 1, -1], fronts=[1, 1, -1, -1])
print('ready')
dog.stand(HEIGHT)
time.sleep(0.5)

print('walking')
dog.gait([[0], [3], [1], [2]], stride=40, lift=35, cycles=3, ticks=14, shift=14)   # creep: one leg at a time
print('turning')
dog.gait([[0], [3], [1], [2]], stride=30, lift=35, turn=0.8, cycles=2, ticks=14, shift=14)
dog.stand(HEIGHT)

print('balancing: tilt it with the pitch/roll sliders on the MPU-6050 card')
while True:
    pitch, roll = imu.angles()
    feet = []
    for i, (x, y, z) in enumerate(STANCE):
        front = 1 if i < 2 else -1
        left = 1 if i % 2 == 0 else -1
        feet.append((x, y + front * pitch * 1.2 - left * roll * 0.8, z))
    dog.apply(feet)
    time.sleep(0.05)
`,
  hexapod: (i2c: string) => `# Hexapod: 18 servos (6 legs x coxa, femur, tibia) on two PCA9685 boards (0x40 and 0x41).
# Press Run: it stands, then walks with a tripod gait (three legs at a time) and turns.
from machine import I2C, Pin
import time
from pca9685 import Servos
from legs import Legs, hex_leg_ik

${i2c}
left = Servos(i2c, 0x40)                # legs L1, L2, L3
right = Servos(i2c, 0x41)               # legs R1, R2, R3
LEGS = [(left, (0, 1, 2)), (left, (3, 4, 5)), (left, (6, 7, 8)), (right, (0, 1, 2)), (right, (3, 4, 5)), (right, (6, 7, 8))]
STANCE = [(90, 80, 0)] * 6              # 90 mm out, 80 mm down from each coxa
bug = Legs(LEGS, hex_leg_ik, STANCE, sides=[1, 1, 1, -1, -1, -1], fronts=[1, 0, -1, 1, 0, -1])
print('ready')
bug.stand(80)
time.sleep(0.5)
TRIPOD = [[0, 2, 4], [1, 3, 5]]         # L1 L3 R2 together, then L2 R1 R3
while True:
    print('walking')
    bug.gait(TRIPOD, stride=50, lift=30, cycles=4, ticks=12)
    print('turning')
    bug.gait(TRIPOD, stride=40, lift=30, turn=1.0, cycles=3, ticks=12)
`,
};
