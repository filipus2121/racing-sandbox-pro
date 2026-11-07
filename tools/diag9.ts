import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
const setup = defaultSetup(GT3_VENOM); setup.absLevel = 0.5;
const c = new Vehicle(GT3_VENOM, setup);
for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
c.place(0, 0, 0, 50); c.gear = 4; c.rpm = 5000;
const inp = { throttle: 0, brake: 1, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
console.log('t  speed  brakePressure  brakeTorqueFL  fxFL  fzFL  slipFL');
for (let s = 0; s < 4; s += 0.5) {
  for (let i = 0; i < 0.5 / dt; i++) stepVehicle(c, inp, defaultEnvironment, dt);
  const w = c.wheels[0];
  console.log((s + 0.5).toFixed(1), c.speed.toFixed(2), c.brakePressure.toFixed(3),
    w.brakeTorque.toFixed(0), w.fx.toFixed(0), w.fz.toFixed(0), w.slipRatio.toFixed(3),
    'sumFx', (c.wheels.reduce((a, x) => a + x.fx, 0)).toFixed(0),
    'accel', c.accelLong.toFixed(2));
}
