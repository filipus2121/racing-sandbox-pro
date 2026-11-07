import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
function rig(speed: number) {
  const c = new Vehicle(GT3_VENOM, defaultSetup(GT3_VENOM));
  for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
  c.place(0, 0, 0, speed); c.gear = 3;
  return c;
}
console.log('steady steer=0.35 at 25 m/s (throttle 0.3):');
{
  const c = rig(25);
  const inp = { throttle: 0.3, brake: 0, steer: 0.35, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 6; s += 1) {
    for (let i = 0; i < 1 / dt; i++) stepVehicle(c, inp, defaultEnvironment, dt);
    console.log(' t', s + 1, 'speed', c.speed.toFixed(1), 'yawRate', c.yawRate.toFixed(3),
      'R', (c.speed / Math.max(1e-6, Math.abs(c.yawRate))).toFixed(1),
      'ay', c.accelLat.toFixed(2), 'latG', (c.speed * c.yawRate / 9.81).toFixed(2),
      'steerAng', c.steeringAngle.toFixed(4),
      'slipA', c.tyres.map(t => t.relaxedSlipAngle.toFixed(4)).join(','),
      'fy', c.wheels.map(w => w.fy.toFixed(0)).join(','));
  }
}
console.log('\nsteady steer=1.0 at 40 m/s:');
{
  const c = rig(40);
  const inp = { throttle: 0.2, brake: 0, steer: 1, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 5; s += 1) {
    for (let i = 0; i < 1 / dt; i++) stepVehicle(c, inp, defaultEnvironment, dt);
    console.log(' t', s + 1, 'speed', c.speed.toFixed(1), 'yawRate', c.yawRate.toFixed(3),
      'R', (c.speed / Math.max(1e-6, Math.abs(c.yawRate))).toFixed(1),
      'latG', (c.speed * c.yawRate / 9.81).toFixed(2),
      'slipA', c.tyres.map(t => t.relaxedSlipAngle.toFixed(4)).join(','));
  }
}
