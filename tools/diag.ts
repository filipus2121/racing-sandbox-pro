import { GT3_VENOM, defaultSetup } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
import { defaultEnvironment } from '../src/physics/cars.js';

function mk() {
  const setup = defaultSetup(GT3_VENOM);
  const car = new Vehicle(GT3_VENOM, setup);
  for (let i = 0; i < 4; i++) {
    car.setSurface(i, { ...NEUTRAL_SURFACE });
    car.tyres[i].coreTemp = GT3_VENOM.tyreRear.tempOpt;
    car.tyres[i].surfaceTemp = GT3_VENOM.tyreRear.tempOpt;
  }
  return car;
}
const dt = 1 / 500;

console.log('=== COAST from 40 m/s, gear 4, no inputs ===');
{
  const c = mk(); c.place(0, 0, 0, 40); c.gear = 4;
  const input = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let i = 0; i < 2 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
  console.log('v', c.speed.toFixed(2), 'rpm', c.rpm.toFixed(0), 'drag', c.dragForce.toFixed(0),
    'fx', c.wheels.map(w => w.fx.toFixed(0)).join(','), 'fz', c.wheels.map(w => w.fz.toFixed(0)).join(','),
    'slipR', c.wheels.map(w => w.slipRatio.toFixed(3)).join(','));
}

console.log('=== AT REST, 1 second, no inputs ===');
{
  const c = mk(); c.place(0, 0, 0, 0); c.gear = 1;
  const input = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let i = 0; i < 1 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
  console.log('v', c.speed.toFixed(4), 'rpm', c.rpm.toFixed(0), 'gear', c.gear,
    'omega', c.tyres.map(t => t.omega.toFixed(1)).join(','),
    'fx', c.wheels.map(w => w.fx.toFixed(1)).join(','),
    'driveT', c.wheels.map(w => w.driveTorque.toFixed(0)).join(','),
    'brakeT', c.wheels.map(w => w.brakeTorque.toFixed(0)).join(','));
}

console.log('=== FULL THROTTLE, gear 2, auto? no. 4 seconds ===');
{
  const c = mk(); c.place(0, 0, 0, 0); c.gear = 1;
  const input = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 4; s += 0.5) {
    for (let i = 0; i < 0.5 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
    console.log('t', s.toFixed(1), 'v', c.speed.toFixed(2), 'kmh', (c.speed * 3.6).toFixed(0),
      'rpm', c.rpm.toFixed(0), 'gear', c.gear,
      'slipR', c.wheels[3].slipRatio.toFixed(3), 'fxR', c.wheels[3].fx.toFixed(0),
      'accel', c.accelLong.toFixed(2));
  }
}

console.log('=== TOP SPEED, gear 6, 40 s ===');
{
  const c = mk(); c.place(0, 0, 0, 20); c.gear = 6;
  const input = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 40; s += 5) {
    for (let i = 0; i < 5 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
    console.log('t', s + 5, 'kmh', (c.speed * 3.6).toFixed(1), 'rpm', c.rpm.toFixed(0),
      'drag', c.dragForce.toFixed(0), 'fxSum', (c.wheels[0].fx + c.wheels[1].fx + c.wheels[2].fx + c.wheels[3].fx).toFixed(0),
      'slipR', c.wheels[3].slipRatio.toFixed(4), 'fzR', c.wheels[3].fz.toFixed(0), 'mu', c.wheels[3].mu.toFixed(3));
  }
}

console.log('=== STEER LEFT at 25 m/s, steer=1 ===');
{
  const c = mk(); c.place(0, 0, 0, 25); c.gear = 3;
  const input = { throttle: 0.3, brake: 0, steer: 1, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 3; s += 0.25) {
    for (let i = 0; i < 0.25 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
    console.log('t', s.toFixed(2), 'steerAng', c.steeringAngle.toFixed(4),
      'slipA', c.wheels.map(w => w.slipAngle.toFixed(4)).join(','),
      'fy', c.wheels.map(w => w.fy.toFixed(0)).join(','),
      'yawRate', c.yawRate.toFixed(4), 'ay', c.accelLat.toFixed(2));
  }
}

console.log('=== REVERSE ===');
{
  const c = mk(); c.place(0, 0, 0, 0); c.gear = -1;
  const input = { throttle: 0.5, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 3; s += 0.5) {
    for (let i = 0; i < 0.5 / dt; i++) stepVehicle(c, input, defaultEnvironment, dt);
    console.log('t', s.toFixed(1), 'vxLocal', c.vxLocal.toFixed(3), 'rpm', c.rpm.toFixed(0),
      'driveT', c.wheels[3].driveTorque.toFixed(0), 'fxR', c.wheels[3].fx.toFixed(0),
      'slipR', c.wheels[3].slipRatio.toFixed(3), 'omega', c.tyres[3].omega.toFixed(1));
  }
}
