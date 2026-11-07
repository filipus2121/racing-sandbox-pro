import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';

const setup = defaultSetup(GT3_VENOM);
const car = new Vehicle(GT3_VENOM, setup);
for (let i = 0; i < 4; i++) {
  car.setSurface(i, { ...NEUTRAL_SURFACE });
  car.tyres[i].coreTemp = GT3_VENOM.tyreRear.tempOpt;
  car.tyres[i].surfaceTemp = GT3_VENOM.tyreRear.tempOpt;
}
car.place(0, 0, 0, 0);
const dt = 1 / 500;
const input = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
console.log('step | v | yawRate | RR: omega wheelVx slipRatio relaxedSR fz fx fy | driveTorque');
for (let i = 0; i < 8; i++) {
  stepVehicle(car, input, defaultEnvironment, dt);
  const w = car.wheels[3];
  const t = car.tyres[3];
  console.log(i, car.speed.toFixed(4), car.yawRate.toFixed(5),
    'om', t.omega.toFixed(4), 'relSR', t.relaxedSlipRatio.toFixed(5),
    'sr', w.slipRatio.toFixed(5), 'fz', w.fz.toFixed(0),
    'fx', w.fx.toFixed(1), 'fy', w.fy.toFixed(1),
    'dT', w.driveTorque.toFixed(1), 'brkT', w.brakeTorque.toFixed(1),
    'mu', w.mu.toFixed(3));
}

console.log('\n=== TYRE STATE at top speed, cold start, gear 6, 60 s ===');
{
  const s2 = defaultSetup(GT3_VENOM);
  const c2 = new Vehicle(GT3_VENOM, s2);
  for (let i = 0; i < 4; i++) {
    c2.setSurface(i, { ...NEUTRAL_SURFACE });
    c2.tyres[i].coreTemp = GT3_VENOM.tyreRear.tempOpt;
    c2.tyres[i].surfaceTemp = GT3_VENOM.tyreRear.tempOpt;
  }
  c2.place(0, 0, 0, 20); c2.gear = 6;
  const inp = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
  for (let s = 0; s < 60; s += 10) {
    for (let i = 0; i < 10 / dt; i++) stepVehicle(c2, inp, defaultEnvironment, dt);
    const t = c2.tyres[3], w = c2.wheels[3];
    console.log('t', s + 10, 'kmh', (c2.speed * 3.6).toFixed(0),
      'core', t.coreTemp.toFixed(1), 'surf', t.surfaceTemp.toFixed(1),
      'wear', t.wear.toFixed(4), 'mu', w.mu.toFixed(3), 'fz', w.fz.toFixed(0),
      'relSR', t.relaxedSlipRatio.toFixed(4), 'fx', w.fx.toFixed(0));
  }
}
