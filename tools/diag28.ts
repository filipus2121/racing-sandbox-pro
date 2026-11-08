/**
 * diag28 - what does 31 degrees of banking do to a car that is not going fast?
 *
 * A banked corner hands the car g*tan(theta) of lateral acceleration towards
 * the inside. At speed, the tyres' outward reaction balances it. At low speed
 * there is nothing to balance it and the car simply slides down the banking -
 * which is correct physics, and also the thing that has to be survived during
 * a pace lap.
 *
 * Measures: drift with no inputs, and whether the follow controller can hold a
 * slow line on the banking.
 */
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { NASCAR_NEXTGEN, PACE_CAR, defaultSetup } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, CarInput, stepVehicle } from '../src/physics/vehicle.js';
import { defaultEnvironment } from '../src/physics/cars.js';
import { newFollowState, followPoint } from '../src/ai/follow.js';
import { SurfaceSample } from '../src/physics/vehicle.js';

const SURF: SurfaceSample = {
  grip: 1, rollingResist: 0, waterDepth: 0, bank: 0,
  slopeAlong: 0, slopeAcross: 0, rubber: 0,
};

const preset = TRACK_PRESETS.find(p => p.id === 'daytona')!;
const track = buildPresetTrack(preset);
const DT = 1 / 500;

console.log(`bank at s=900: ${(track.bankAt(track.pointAt(900).index) * 180 / Math.PI).toFixed(1)} deg`);
console.log(`gravity component down the banking: ${(Math.tan(0.5411) * 9.81).toFixed(2)} m/s^2 ` +
  `= ${(Math.tan(0.5411)).toFixed(2)} g\n`);

// --- Free drift on the banking, no driver --------------------------------
console.log('free drift on the banking (no inputs), 6 seconds:');
for (const v0 of [0, 5, 10, 20, 32, 50]) {
  const car = new Vehicle(NASCAR_NEXTGEN, defaultSetup(NASCAR_NEXTGEN));
  const pose = track.pointAt(900, -4);
  car.place(pose.x, pose.y, pose.heading, v0);
  car.gear = 2;
  car.rpm = 3000;
  for (let i = 0; i < 6 * 500; i++) {
    for (let w = 0; w < 4; w++) {
      const wp = car.wheelPosition(w);
      const c = Math.cos(car.heading);
      const sn = Math.sin(car.heading);
      track.fillSurface(car.x + wp.x * c - wp.y * sn, car.y + wp.x * sn + wp.y * c,
        SURF, -1, car.heading);
      car.setSurface(w, SURF);
    }
    stepVehicle(car, { ...NO_INPUT }, defaultEnvironment, DT);
  }
  const q = track.query(car.x, car.y);
  console.log(`  v0 ${String(v0 * 3.6).padStart(3)} km/h -> lat ${q.lateral.toFixed(1).padStart(7)} m  ` +
    `vxLocal ${car.vxLocal.toFixed(1).padStart(6)}  vyLocal ${car.vyLocal.toFixed(1).padStart(6)}  ` +
    `speed ${(car.speed * 3.6).toFixed(0)} km/h`);
}

// --- Follow controller holding a slow line on the banking -----------------
console.log('\nfollow controller holding the racing line at a target speed:');
for (const target of [10, 20, 32, 45]) {
  const car = new Vehicle(PACE_CAR, defaultSetup(PACE_CAR));
  const pose = track.pointAt(900, -4);
  car.place(pose.x, pose.y, pose.heading, target);
  car.gear = 2;
  car.rpm = 2500;
  const st = newFollowState();
  let s = 900;
  let worstLat = 0;
  for (let i = 0; i < 12 * 500; i++) {
    const idx = track.nearestIndex(car.x, car.y);
    s = track.query(car.x, car.y, idx).s;
    const tp = track.pointAt(track.wrap(s + 26), -4);
    const input: CarInput = { ...NO_INPUT };
    followPoint(car, tp.x, tp.y, target, DT, st, input, undefined,
      { curvature: track.curvature[idx], bank: track.bankAt(idx) });
    for (let w = 0; w < 4; w++) {
      const wp = car.wheelPosition(w);
      const c = Math.cos(car.heading);
      const sn = Math.sin(car.heading);
      track.fillSurface(car.x + wp.x * c - wp.y * sn, car.y + wp.x * sn + wp.y * c,
        SURF, -1, car.heading);
      car.setSurface(w, SURF);
    }
    stepVehicle(car, input, defaultEnvironment, DT);
    const q = track.query(car.x, car.y, track.nearestIndex(car.x, car.y));
    worstLat = Math.max(worstLat, Math.abs(q.lateral + 4));
  }
  console.log(`  target ${String(target * 3.6).padStart(3)} km/h -> held ${worstLat.toFixed(2)} m off the line, ` +
    `final speed ${(car.speed * 3.6).toFixed(0)} km/h, rpm ${car.rpm.toFixed(0)}, gear ${car.gear}`);
}
