import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
for (const tc of [1.0, 0.0]) {
  const setup = defaultSetup(GT3_VENOM); setup.tcLevel = tc; setup.throttleMap = 1;
  const c = new Vehicle(GT3_VENOM, setup);
  for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
  c.place(0, 0, 0, 0); c.gear = 1; c.rpm = GT3_VENOM.engine.idleRpm;
  const inp = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  let shiftHold = 0, t100 = -1;
  for (let i = 0; i < 10 / dt; i++) {
    inp.shiftUp = false;
    if (shiftHold <= 0 && c.rpm > GT3_VENOM.engine.redlineRpm * 0.93 && c.gear < c.gearCount()) { inp.shiftUp = true; shiftHold = 0.06; }
    shiftHold -= dt;
    stepVehicle(c, inp, defaultEnvironment, dt);
    if (t100 < 0 && c.speed * 3.6 >= 100) t100 = i * dt;
    if (i % 1000 === 0) console.log('tc', tc, 't', (i*dt).toFixed(1), 'v', (c.speed*3.6).toFixed(1), 'gear', c.gear,
      'rpm', Math.round(c.rpm), 'yaw', c.yawRate.toFixed(2), 'hdg', c.heading.toFixed(2),
      'slipRR', c.tyres[3].relaxedSlipRatio.toFixed(2));
  }
  console.log('tc', tc, '=> 0-100', t100.toFixed(2), 's  final', (c.speed*3.6).toFixed(1), 'km/h gear', c.gear);
}
