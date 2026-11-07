import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
// Steady circle: hold a fixed steer and see what lateral g the car settles at.
for (const v0 of [10, 15, 20, 25]) {
  const setup = defaultSetup(GT3_VENOM);
  const c = new Vehicle(GT3_VENOM, setup);
  for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
  c.place(0, 0, 0, v0); c.gear = 3; c.rpm = 6000;
  const inp = { throttle: 0, brake: 0, steer: 1, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let i = 0; i < 6 / dt; i++) stepVehicle(c, inp, defaultEnvironment, dt);
  const latG = (c.speed * c.yawRate) / 9.81;
  const radius = c.speed / Math.max(1e-6, c.yawRate);
  console.log('v0', v0, '-> settled v', c.speed.toFixed(1), 'm/s  yawRate', c.yawRate.toFixed(3),
    ' radius', radius.toFixed(1), 'm  latG', latG.toFixed(3),
    ' steerAngle', c.steeringAngle.toFixed(4), 'rad',
    ' utilFL', c.wheels[0].utilisation.toFixed(2), 'utilRR', c.wheels[3].utilisation.toFixed(2),
    ' muFL', c.wheels[0].mu.toFixed(2), 'muRR', c.wheels[3].mu.toFixed(2));
}
