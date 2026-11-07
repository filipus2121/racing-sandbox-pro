import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
// Hold a fixed radius with a yaw-rate servo and hold speed with a throttle
// servo, then report the lateral g the tyres actually deliver.
function circle(radius: number, speed: number) {
  const setup = defaultSetup(GT3_VENOM);
  const c = new Vehicle(GT3_VENOM, setup);
  for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
  c.place(0, 0, 0, speed); c.gear = 3; c.rpm = 6000;
  const k = 1 / radius;
  const inp = { throttle: 0.3, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  let iYaw = 0, iSpd = 0.3;
  for (let i = 0; i < 8 / dt; i++) {
    const eYaw = speed * k - c.yawRate;
    iYaw = Math.max(-0.5, Math.min(0.5, iYaw + eYaw * 0.9 * dt));
    inp.steer = Math.max(-1, Math.min(1, eYaw * 1.1 + iYaw));
    const eSpd = speed - c.speed;
    iSpd = Math.max(0, Math.min(1, iSpd + eSpd * 0.5 * dt));
    inp.throttle = iSpd;
    inp.brake = eSpd < -1 ? 0.2 : 0;
    stepVehicle(c, inp, defaultEnvironment, dt);
  }
  return {
    latG: (c.speed * c.yawRate) / 9.81,
    v: c.speed,
    rAchieved: c.speed / Math.max(1e-6, c.yawRate),
    util: Math.max(...c.wheels.map(w => w.utilisation)),
    steer: c.steeringAngle,
  };
}
for (const r of [20, 40, 60, 100]) {
  for (const v of [12, 18, 24, 30]) {
    const o = circle(r, v);
    console.log('R', String(r).padStart(3), 'demand v', String(v).padStart(2),
      '=> actual v', o.v.toFixed(1).padStart(5),
      'R_ach', o.rAchieved.toFixed(1).padStart(6),
      'latG', o.latG.toFixed(3), 'maxUtil', o.util.toFixed(2), 'steer', o.steer.toFixed(4));
  }
}
