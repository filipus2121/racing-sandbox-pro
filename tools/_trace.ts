import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { PACE_CAR, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, NO_INPUT, CarInput, stepVehicle, SurfaceSample } from '../src/physics/vehicle.js';
import { newFollowState, followPoint } from '../src/ai/follow.js';
import { normalizeAngle } from '../src/core/math.js';

const track = buildPresetTrack(TRACK_PRESETS.find(p => p.id === 'daytona')!);
const DT = 1 / 500;
const SURF: SurfaceSample = { grip: 1, rollingResist: 0, waterDepth: 0, bank: 0, slopeAlong: 0, slopeAcross: 0, rubber: 0 };
const car = new Vehicle(PACE_CAR, defaultSetup(PACE_CAR));
const pose = track.pointAt(900, -4);
car.place(pose.x, pose.y, pose.heading, 20);
car.gear = 2; car.rpm = 2500;
const st = newFollowState();
console.log(' t     s      lat    dLong  dLat   desSlip actSlip headErr  yaw    steer  thr  kmh  steerAngle');
for (let i = 0; i < 4 * 500; i++) {
  const idx = track.nearestIndex(car.x, car.y);
  const q = track.query(car.x, car.y, idx);
  const tp = track.pointAt(track.wrap(q.s + 26), -4);
  const input: CarInput = { ...NO_INPUT };
  followPoint(car, tp.x, tp.y, 20, DT, st, input);
  if (i % 100 === 0) {
    const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
    const dx = tp.x - car.x, dy = tp.y - car.y;
    const dLong = dx * cosH + dy * sinH;
    const dLat = -dx * sinH + dy * cosH;
    console.log(
      `${(i*DT).toFixed(1).padStart(4)} ${q.s.toFixed(0).padStart(6)} ${q.lateral.toFixed(2).padStart(7)} ` +
      `${dLong.toFixed(1).padStart(6)} ${dLat.toFixed(2).padStart(6)} ` +
      `${Math.atan2(dLat, Math.max(2.5, dLong)).toFixed(3).padStart(7)} ` +
      `${Math.atan2(car.vyLocal, Math.max(0.6, car.vxLocal)).toFixed(3).padStart(7)} ` +
      `${normalizeAngle(Math.atan2(dy, dx) - car.heading).toFixed(3).padStart(7)} ` +
      `${car.yawRate.toFixed(3).padStart(6)} ${input.steer.toFixed(3).padStart(7)} ` +
      `${input.throttle.toFixed(2).padStart(5)} ${(car.speed*3.6).toFixed(0).padStart(4)} ` +
      `${(car.steeringAngle*180/Math.PI).toFixed(2).padStart(6)}`);
  }
  for (let w = 0; w < 4; w++) {
    const wp = car.wheelPosition(w);
    const c = Math.cos(car.heading), sn = Math.sin(car.heading);
    track.fillSurface(car.x + wp.x*c - wp.y*sn, car.y + wp.x*sn + wp.y*c, SURF, -1, car.heading);
    car.setSurface(w, SURF);
  }
  stepVehicle(car, input, defaultEnvironment, DT);
}
