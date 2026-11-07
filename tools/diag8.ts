import { GT3_VENOM } from '../src/physics/cars.js';
import { tyreForces } from '../src/physics/tire.js';
const spec = GT3_VENOM.tyreRear;
console.log('corneringStiffness', spec.corneringStiffness, 'refLoad', spec.refLoad,
  'muPeak', spec.muPeak, 'shapeC', spec.shapeC, 'loadSens', spec.loadSensitivity);
for (const sa of [0.02, 0.06, 0.12, 0.25]) {
  const st = { coreTemp: spec.tempOpt, surfaceTemp: spec.tempOpt, wear: 0, omega: 0, slipEnergy: 0,
    relaxedSlipAngle: sa, relaxedSlipRatio: 0 };
  const f = tyreForces(spec, st, { fz: spec.refLoad, slipRatio: 0, slipAngle: sa, camber: 0,
    vx: 30, waterDepth: 0, surfaceGrip: 1 },
    { trackTempC: 30, speed: 30, pressureBar: spec.pressureOpt, dt: 0 });
  console.log('slipAngle', sa.toFixed(3), 'fy', f.fy.toFixed(1), 'mu', f.mu.toFixed(3),
    'peakLat', f.peakLat.toFixed(0), 'utilisation', f.combinedSlip.toFixed(3));
}
