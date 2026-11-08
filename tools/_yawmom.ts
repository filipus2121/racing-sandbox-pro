import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { PACE_CAR, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, stepVehicle, SurfaceSample } from '../src/physics/vehicle.js';

const track = buildPresetTrack(TRACK_PRESETS.find(p => p.id === 'daytona')!);
const DT = 1 / 500;
const SURF: SurfaceSample = { grip: 1, rollingResist: 0, waterDepth: 0, bank: 0, slopeAcross: 0, slopeAlong: 0, rubber: 0 };
const V0 = Number(process.argv[2] ?? '10');
const THR = Number(process.argv[3] ?? '0');
void (0 as number);

// No driver at all: wheels straight, coasting, on 31 degrees.
const car = new Vehicle(PACE_CAR, defaultSetup(PACE_CAR));
const pose = track.pointAt(900, -4);
car.place(pose.x, pose.y, pose.heading, V0);
car.gear = V0 > 25 ? 3 : 2; car.rpm = 3000;
console.log(`31deg banking, wheels straight, v0 = ${V0} m/s, throttle = ${THR}`);
console.log('  t    vx    vLat   yawRate  yawMom(Nm) | FL fy   FR fy   RL fy   RR fy | FL fz   FR fz   RL fz   RR fz | alpha_f alpha_r (deg)');
for (let i = 0; i < 6 * 500; i++) {
  for (let w = 0; w < 4; w++) {
    const wp = car.wheelPosition(w);
    const c = Math.cos(car.heading), sn = Math.sin(car.heading);
    track.fillSurface(car.x + wp.x * c - wp.y * sn, car.y + wp.x * sn + wp.y * c, SURF, -1, car.heading);
    car.setSurface(w, SURF);
  }
  stepVehicle(car, { ...NO_INPUT, throttle: THR }, defaultEnvironment, DT);
  if (i % 125 === 0) {
    let m = 0;
    for (let w = 0; w < 4; w++) {
      const p = car.wheelPosition(w);
      m += p.x * car.wheels[w].fy - p.y * car.wheels[w].fx;
    }
    const f = car.wheels;
    const af = ((f[0].slipAngle + f[1].slipAngle) / 2) * 180 / Math.PI;
    const ar = ((f[2].slipAngle + f[3].slipAngle) / 2) * 180 / Math.PI;
    console.log(`  sr: ` + [0,1,2,3].map(w => (f[w].slipRatio * 100).toFixed(1).padStart(7)).join(' ') +
      ` %  | driveNm ` + [0,1,2,3].map(w => car.wheels[w].driveTorque.toFixed(0).padStart(6)).join(' ') +
      ` | mu ` + [0,1,2,3].map(w => car.wheels[w].mu.toFixed(2).padStart(5)).join(' ') + ` | brkNm ` + [0,1,2,3].map(w => car.wheels[w].brakeTorque.toFixed(0).padStart(6)).join(' '));
    console.log(`${(i / 500).toFixed(2).padStart(5)} ${car.vxLocal.toFixed(1).padStart(6)} ${car.vyLocal.toFixed(2).padStart(6)} ${car.yawRate.toFixed(3).padStart(8)}` +
      `${m.toFixed(0).padStart(11)} | ` + [0,1,2,3].map(w => (f[w].fy / 1000).toFixed(2).padStart(7)).join(' ') +
      ` | ` + [0,1,2,3].map(w => (f[w].fz / 1000).toFixed(2).padStart(7)).join(' ') +
      ` | ${af.toFixed(2).padStart(7)} ${ar.toFixed(2).padStart(7)}`);
  }
}
void BANK;
