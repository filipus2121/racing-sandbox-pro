import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { tyreForces } from '../src/physics/tire.js';

const spec = GT3_VENOM.tyreRear;
const st = { coreTemp: 92, surfaceTemp: 92, wear: 0, omega: 0, slipEnergy: 0, relaxedSlipAngle: 0, relaxedSlipRatio: 0.011 };
const f = tyreForces(spec, st, {
  fz: 11917, slipRatio: 0.011, slipAngle: 0, camber: 0,
  vx: 51, waterDepth: 0, surfaceGrip: 1,
}, { trackTempC: 32, speed: 51, pressureBar: spec.pressureOpt, dt: 0.002 });
console.log('mu', f.mu.toFixed(4), 'fx', f.fx.toFixed(1), 'rollingResist', f.rollingResist.toFixed(1));
console.log('slipEnergyRate', f.slipEnergyRate.toFixed(1), 'W');
console.log('hysteresis', (f.rollingResist * 51 * 0.5).toFixed(1), 'W');
const total = f.slipEnergyRate + f.rollingResist * 51 * 0.5;
console.log('total W', total.toFixed(1), '-> kW*heatGain =', (total / 1000 * 0.03).toFixed(2));
const bath = 0.4 * defaultEnvironment.airTempC + 0.6 * 32;
console.log('bath', bath.toFixed(1));
for (const surf of [28, 60, 90, 103]) {
  const conv = (0.9 + 0.038 * 51) * (surf - bath);
  const s2c = (surf - 92) * 0.15;
  console.log('surf', surf, 'heat', (total / 1000 * 0.03).toFixed(2), 'conv', conv.toFixed(2), 's2c', s2c.toFixed(2),
    '=> dsurf/dt', (total / 1000 * 0.03 - conv - s2c).toFixed(2));
}
