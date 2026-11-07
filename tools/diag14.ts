import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
const setup = defaultSetup(GT3_VENOM); setup.tcLevel = 1; setup.throttleMap = 1;
const c = new Vehicle(GT3_VENOM, setup);
for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
c.place(0, 0, 0, 0); c.gear = 1; c.rpm = GT3_VENOM.engine.idleRpm;
const inp = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
let shiftHold = 0, t100 = -1;
for (let i = 0; i < 10 / dt; i++) {
  const slip = Math.max(c.tyres[2].relaxedSlipRatio, c.tyres[3].relaxedSlipRatio);
  inp.throttle = Math.max(0.05, Math.min(1, inp.throttle + (0.12 - slip) * 8 * dt));
  inp.shiftUp = false;
  if (shiftHold <= 0 && c.rpm > GT3_VENOM.engine.redlineRpm * 0.93 && c.gear < c.gearCount()) { inp.shiftUp = true; shiftHold = 0.06; }
  shiftHold -= dt;
  stepVehicle(c, inp, defaultEnvironment, dt);
  if (t100 < 0 && c.speed * 3.6 >= 100) t100 = i * dt;
  if (i % 1000 === 0) console.log('t', (i*dt).toFixed(1), 'v', (c.speed*3.6).toFixed(1), 'thr', inp.throttle.toFixed(2),
    'gear', c.gear, 'slip', slip.toFixed(2), 'yaw', c.yawRate.toFixed(3), 'hdg', c.heading.toFixed(3));
}
console.log('0-100 =', t100.toFixed(2), 's  final', (c.speed*3.6).toFixed(1), 'km/h');
