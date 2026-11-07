import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const c = new Vehicle(GT3_VENOM, defaultSetup(GT3_VENOM));
for (let i = 0; i < 4; i++) c.setSurface(i, { ...NEUTRAL_SURFACE });
const dt = 1 / 500;
const inp = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
for (let i = 0; i < 200; i++) stepVehicle(c, inp, defaultEnvironment, dt);
const sum = c.wheels.reduce((a, w) => a + w.fz, 0);
console.log('mass', c.mass.toFixed(1), 'kg  -> weight', (c.mass * 9.80665).toFixed(0), 'N');
console.log('sum of wheel fz          =', sum.toFixed(0), 'N   <-- must equal weight');
console.log('per wheel fz             =', c.wheels.map(w => w.fz.toFixed(0)).join(', '));
console.log('front share              =',
  (((c.wheels[0].fz + c.wheels[1].fz) / sum) * 100).toFixed(1), '% (setup says 48%)');
