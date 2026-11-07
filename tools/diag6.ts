import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
const c = new Vehicle(GT3_VENOM, defaultSetup(GT3_VENOM));
for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
c.place(0, 0, 0, 25); c.gear = 3;
const inp = { throttle: 0.3, brake: 0, steer: 0.35, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
for (let i = 0; i < 2 / dt; i++) stepVehicle(c, inp, defaultEnvironment, dt);
let sfy = 0, sfyWheel = 0, vy = 0, n = 0;
let maxFy = 0, minFy = 0;
for (let i = 0; i < 1 / dt; i++) {
  stepVehicle(c, inp, defaultEnvironment, dt);
  sfy += c.accelLat * c.mass;
  const s = c.wheels.reduce((a, w) => a + w.fy, 0);
  sfyWheel += s; maxFy = Math.max(maxFy, s); minFy = Math.min(minFy, s);
  vy += c.vyLocal; n++;
}
console.log('mass', c.mass.toFixed(0), 'speed', c.speed.toFixed(2), 'yawRate', c.yawRate.toFixed(4));
console.log('required centripetal m*v*omega =', (c.mass * c.speed * c.yawRate).toFixed(0), 'N');
console.log('mean sumFy from wheels       =', (sfyWheel / n).toFixed(1), 'N  (min', minFy.toFixed(0), 'max', maxFy.toFixed(0), ')');
console.log('mean m*accelLat              =', (sfy / n).toFixed(1), 'N');
console.log('mean vyLocal                 =', (vy / n).toFixed(4), 'm/s');
console.log('heading', c.heading.toFixed(4), 'vx', c.vx.toFixed(2), 'vy', c.vy.toFixed(2));
