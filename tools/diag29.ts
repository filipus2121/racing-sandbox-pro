/**
 * diag29 - what constant steering angle actually holds a banked arc?
 *
 * The naive feedforward for a corner is delta = wheelbase / R. On a banked oval
 * that is wrong in both directions: the banking supplies part of the lateral
 * acceleration, so the tyres - and the steering - owe only the difference, and
 * near the neutral-steer speed the required angle goes through zero and changes
 * sign.
 *
 * Rather than guess a formula, this measures it: for each speed it bisects on a
 * constant steering input until the car holds its lateral offset on the arc,
 * then prints the answer so the feedforward can be checked against reality.
 */
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { NASCAR_NEXTGEN, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, CarInput, stepVehicle, SurfaceSample } from '../src/physics/vehicle.js';
import { Track } from '../src/track/track.js';

const track: Track = buildPresetTrack(TRACK_PRESETS.find(p => p.id === 'daytona')!);
const DT = 1 / 500;
const S0 = 900;      // mid turn 3-4, full 31 degrees
const LAT = -4;

const SURF: SurfaceSample = {
  grip: 1, rollingResist: 0, waterDepth: 0, bank: 0,
  slopeAlong: 0, slopeAcross: 0, rubber: 0,
};

/** Run 10 s with a fixed steering input; return the final lateral error. */
function hold(steer: number, v0: number): number {
  const car = new Vehicle(NASCAR_NEXTGEN, defaultSetup(NASCAR_NEXTGEN));
  const pose = track.pointAt(S0, LAT);
  car.place(pose.x, pose.y, pose.heading, v0);
  car.gear = 4;
  car.rpm = 6000;
  for (let i = 0; i < 10 * 500; i++) {
    for (let w = 0; w < 4; w++) {
      const wp = car.wheelPosition(w);
      const c = Math.cos(car.heading);
      const sn = Math.sin(car.heading);
      track.fillSurface(car.x + wp.x * c - wp.y * sn, car.y + wp.x * sn + wp.y * c,
        SURF, -1, car.heading);
      car.setSurface(w, SURF);
    }
    // Hold the speed: we are measuring a steady-state steer angle, so the
    // speed has to be the one we asked for rather than whatever the engine
    // happens to produce.
    const err = v0 - car.speed;
    const input: CarInput = {
      ...NO_INPUT, steer,
      throttle: err > 0.3 ? 0.55 : 0,
      brake: err < -0.3 ? 0.1 : 0,
    };
    stepVehicle(car, input, defaultEnvironment, DT);
    const q = track.query(car.x, car.y, track.nearestIndex(car.x, car.y));
    if (Math.abs(q.lateral) > 40) return q.lateral;
  }
  const q = track.query(car.x, car.y, track.nearestIndex(car.x, car.y));
  return q.lateral - LAT;
}

console.log('Daytona turn 3-4: R = 330 m, banking 31 deg, Next Gen');
console.log('kinematic steer for the arc alone = ' +
  `${(Math.atan(2.794 / 330) * 180 / Math.PI).toFixed(3)} deg of road wheel\n`);
console.log(' km/h    steer(norm)  road wheel deg   lat err   naive atan(L*k) deg');
for (const kmh of [40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280]) {
  const v0 = kmh / 3.6;
  // Establish the response direction first; assuming it makes the bisection
  // silently converge on whichever bound it started from.
  const probe = hold(0.05, v0) - hold(-0.05, v0);
  const sign = probe > 0 ? 1 : -1;
  let lo = -1;
  let hi = 1;
  let best = 0;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    const e = hold(mid, v0) * sign;
    if (!Number.isFinite(e)) { hi = mid; continue; }
    if (e > 0) hi = mid;
    else lo = mid;
    best = mid;
  }
  const err = hold(best, v0);
  const lock = NASCAR_NEXTGEN.steer.maxLock /
    (1 + v0 / (NASCAR_NEXTGEN.steer.speedSensitiveKmh / 3.6));
  console.log(`${String(kmh).padStart(4)}  ${best.toFixed(4).padStart(11)}  ` +
    `${(best * lock * 180 / Math.PI).toFixed(3).padStart(13)}  ` +
    `${err.toFixed(2).padStart(8)}  ` +
    `${(Math.atan(2.794 / 330) * 180 / Math.PI).toFixed(3).padStart(12)}`);
}
