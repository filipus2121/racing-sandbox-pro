import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
for (const abs of [0.0, 0.5, 1.0]) {
  const setup = defaultSetup(GT3_VENOM); setup.absLevel = abs;
  const c = new Vehicle(GT3_VENOM, setup);
  for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
  c.place(0, 0, 0, 50); c.gear = 4; c.rpm = 5000;
  const inp = { throttle: 0, brake: 1, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  const x0 = c.x;
  let peakG = 0;
  for (let i = 0; i < 8 / dt; i++) { stepVehicle(c, inp, defaultEnvironment, dt); peakG = Math.max(peakG, -c.accelLong / 9.81); }
  console.log('abs', abs.toFixed(1), '| stop distance', (c.x - x0).toFixed(1), 'm',
    '| final speed', c.speed.toFixed(2),
    '| peak decel', peakG.toFixed(2), 'g',
    '| yawRate', c.yawRate.toFixed(3),
    '| heading', c.heading.toFixed(3));
}
