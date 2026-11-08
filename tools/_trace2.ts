import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { PACE_CAR, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, CarInput, stepVehicle, SurfaceSample } from '../src/physics/vehicle.js';
import { newFollowState, followPoint } from '../src/ai/follow.js';

const track = buildPresetTrack(TRACK_PRESETS.find(p => p.id === 'daytona')!);
const DT = 1 / 500;
const SURF: SurfaceSample = { grip: 1, rollingResist: 0, waterDepth: 0, bank: 0, slopeAlong: 0, slopeAcross: 0, rubber: 0 };
const LAT0 = -4;
const BANK_SCALE = Number(process.argv[2] ?? '1');
const V0 = Number(process.argv[3] ?? '10');

const car = new Vehicle(PACE_CAR, defaultSetup(PACE_CAR));
const pose = track.pointAt(900, LAT0);
car.place(pose.x, pose.y, pose.heading, V0);
car.gear = 2; car.rpm = 2500;
const st = newFollowState();
console.log(`banking x${BANK_SCALE}, v0 = ${V0} m/s, lateral sign: +lateral = left of the line`);
console.log(' t    lat     dLong  steer   yaw    vLat   Fy(kN)  Fz(kN)  thr  brk  grip  k');
for (let i = 0; i < 6 * 500; i++) {
  const idx = track.nearestIndex(car.x, car.y);
  const q0 = track.query(car.x, car.y, idx);
  const s = q0.s;
  const tp = track.pointAt(track.wrap(s + 26), LAT0);
  const input: CarInput = { ...NO_INPUT };
  followPoint(car, tp.x, tp.y, V0, DT, st, input, undefined,
    { curvature: track.curvature[idx], bank: track.bankAt(idx) });
  let fy = 0, fz = 0;
  for (let w = 0; w < 4; w++) {
    const wp = car.wheelPosition(w);
    const c = Math.cos(car.heading), sn = Math.sin(car.heading);
    track.fillSurface(car.x + wp.x * c - wp.y * sn, car.y + wp.x * sn + wp.y * c, SURF, -1, car.heading);
    SURF.bank *= BANK_SCALE; SURF.slopeAcross *= BANK_SCALE;
    car.setSurface(w, SURF);
  }
  stepVehicle(car, input, defaultEnvironment, DT);
  for (let w = 0; w < 4; w++) { fy += car.wheels[w].fy; fz += car.wheels[w].fz; }
  if (i % 100 === 0) {
    const q = track.query(car.x, car.y, track.nearestIndex(car.x, car.y));
    console.log(`${(i / 500).toFixed(1).padStart(4)} ${(q.lateral - LAT0).toFixed(2).padStart(7)} ` +
      `${(q.s - s).toFixed(2).padStart(7)} ${input.steer.toFixed(3).padStart(7)} ${car.yawRate.toFixed(3).padStart(7)}` +
      `${car.vyLocal.toFixed(2).padStart(7)} ${(fy / 1000).toFixed(2).padStart(8)} ${(fz / 1000).toFixed(2).padStart(8)}` +
      `${input.throttle.toFixed(2).padStart(5)} ${input.brake.toFixed(2).padStart(5)} ` +
      `${track.query(car.x, car.y, track.nearestIndex(car.x, car.y)).grip.toFixed(2).padStart(5)} ` +
      `${(track.curvature[idx] * 1000).toFixed(3).padStart(6)}`);
  }
}
