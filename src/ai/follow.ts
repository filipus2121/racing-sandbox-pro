import { Rng, clamp, normalizeAngle } from '../core/math.js';
import { CarInput, Vehicle } from '../physics/vehicle.js';
import { Track } from '../track/track.js';

/**
 * A point-to-point driver.
 *
 * The opponents in `opponent.ts` race: they choose a line, plan braking
 * distances and fight for position. This does none of that. It drives the car
 * to a place at a speed, which is what every non-racing job on track needs -
 * the pace car, holding a restart slot behind the pace car, and the run down
 * pit road. Keeping it here rather than inside `Opponent` means one servo is
 * tuned instead of three, and none of them can be broken by a change to the
 * racing logic.
 */
export interface FollowGains {
  /** Slip-angle error gain. */
  kp: number;
  /** Heading error gain. */
  kh: number;
  /** Yaw-rate damping. */
  kd: number;
  /** How hard to accelerate per m/s of speed deficit. */
  throttleGain: number;
  /** How hard to brake per m/s of speed excess. */
  brakeGain: number;
}

export const DEFAULT_FOLLOWS: FollowGains = {
  kp: 2.4, kh: 1.1, kd: 0.4, throttleGain: 0.34, brakeGain: 0.16,
};

/**
 * What the road under the car is doing, for the steering feedforward.
 *
 * On a banked oval this is not a refinement, it is the whole control problem.
 * Banking supplies g*tan(theta) of lateral acceleration towards the inside for
 * free, so on 31 degrees at a 330 m radius the car holds the arc with the
 * wheels straight at 159 km/h. Below that speed the tyres have to push the car
 * back OUT of the corner and the correct steering input is downhill, to the
 * right. A controller that only knows "the track turns left, so steer left"
 * fights the banking and is thrown off the top of it.
 */
export interface RoadHint {
  /** Signed curvature of the intended path, 1/m (positive = left). */
  curvature: number;
  /** Cross-slope, rad. Carried for diagnostics; see followPoint for why the
   * steering feedforward does not use it. */
  bank: number;
}

export interface FollowState {
  smoothThrottle: number;
  smoothBrake: number;
  smoothSteer: number;
  gearHold: number;
}

export function newFollowState(): FollowState {
  return { smoothThrottle: 0, smoothBrake: 0, smoothSteer: 0, gearHold: 0 };
}

/**
 * Drive towards a world-space point at a target speed.
 *
 * `lookahead` matters more than it looks: aiming straight at the target makes
 * the controller oscillate because by the time the car gets there the target
 * has effectively moved. Aiming a few metres down the line damps it.
 */
export function followPoint(
  car: Vehicle,
  targetX: number,
  targetY: number,
  targetSpeed: number,
  dt: number,
  state: FollowState,
  out: CarInput,
  gains: FollowGains = DEFAULT_FOLLOWS,
  road?: RoadHint,
): void {
  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  const dx = targetX - car.x;
  const dy = targetY - car.y;
  const dLong = dx * cosH + dy * sinH;
  const dLat = -dx * sinH + dy * cosH;

  const desiredSlip = Math.atan2(dLat, Math.max(2.5, dLong));
  const actualSlip = Math.atan2(car.vyLocal, Math.max(0.6, car.vxLocal));
  const desiredHeading = Math.atan2(dy, dx);
  const headingErr = normalizeAngle(desiredHeading - car.heading);

  // Once the target is behind us, stop steering towards it: otherwise the
  // controller swings the nose back and forth around a point it has passed.
  const passed = dLong < -1;

  // Feedforward from the path curvature: delta = wheelbase / R, the bicycle
  // model. Normalised by the lock actually available at this speed, because the
  // rack is speed sensitive, so the same normalised value means less wheel the
  // faster we go.
  //
  // Measured, not assumed (tools/diag29.ts). The tempting refinement - steer
  // only for the part of the lateral acceleration the banking does not supply -
  // is WRONG here, and measurably so: on 31 degrees at 60 km/h a Next Gen with
  // the wheels straight holds a 2891 m radius, i.e. it goes essentially
  // straight, because the tyres resist the downhill slide almost completely
  // (mu 1.0 against tan(31) = 0.6). Banking buys cornering SPEED by paying for
  // part of the lateral force; it does not much change the ANGLE the wheels
  // need, which stays close to wheelbase / R.
  let ff = 0;
  if (road) {
    const lock = car.spec.steer.maxLock /
      (1 + car.speed / (car.spec.steer.speedSensitiveKmh / 3.6));
    ff = Math.atan(car.spec.wheelbase * road.curvature) / Math.max(0.05, lock);
  }

  let steer = ff + (desiredSlip - actualSlip) * gains.kp +
    (passed ? 0 : headingErr * gains.kh) -
    car.yawRate * gains.kd;
  steer = clamp(steer, -1, 1);

  const maxRate = car.spec.steer.maxRate / Math.max(0.05, car.spec.steer.maxLock) * 0.85;
  steer = clamp(steer, state.smoothSteer - maxRate * dt, state.smoothSteer + maxRate * dt);
  state.smoothSteer = steer;

  const speedError = targetSpeed - car.speed;
  let throttle = 0;
  let brake = 0;
  if (speedError > 0.3) {
    throttle = clamp(speedError * gains.throttleGain, 0, 1);
    // Do not power on while the steering is working: this is a manoeuvre, not
    // a lap, and a stock car on a spooled diff will step out on throttle.
    throttle *= clamp(1.25 - Math.abs(steer) * 1.4, 0.15, 1);
  } else if (speedError < -0.3) {
    brake = clamp(-speedError * gains.brakeGain, 0, 1);
  }

  state.smoothThrottle += clamp(throttle - state.smoothThrottle, -7 * dt, 5 * dt);
  state.smoothBrake += clamp(brake - state.smoothBrake, -10 * dt, 8 * dt);

  // Gears: keep it out of the rev limiter and out of lugging.
  state.gearHold = Math.max(0, state.gearHold - dt);
  let shiftUp = false;
  let shiftDown = false;
  if (state.gearHold <= 0) {
    const red = car.spec.engine.redlineRpm;
    if (car.gear === 0) {
      shiftUp = true;
      state.gearHold = 0.2;
    } else if (car.rpm > red * 0.88 && car.gear < car.gearCount()) {
      shiftUp = true;
      state.gearHold = car.spec.engine.upshiftTime + 0.06;
    } else if (car.rpm < red * 0.35 && car.gear > 1) {
      shiftDown = true;
      state.gearHold = car.spec.engine.downshiftTime + 0.08;
    }
  }

  out.throttle = clamp(state.smoothThrottle, 0, 1);
  out.brake = clamp(state.smoothBrake, 0, 1);
  out.steer = clamp(steer, -1, 1);
  out.clutch = 0;
  out.shiftUp = shiftUp;
  out.shiftDown = shiftDown;
  out.handbrake = 0;
}

/** World position of a point `ahead` metres along the track from `s`, at `lateral`. */
export function poseAhead(
  track: Track, s: number, lateral: number,
): { x: number; y: number; heading: number; index: number } {
  return track.pointAt(track.wrap(s), lateral);
}

/**
 * Deterministic jitter used by the pace car and the pit controller so they do
 * not drive a mathematically perfect line, which reads as a rail.
 */
export function wander(rng: Rng, phase: number, amount: number): number {
  return (Math.sin(phase * 1.7) * 0.6 + Math.sin(phase * 4.1 + 1.3) * 0.4) * amount *
    (0.6 + rng.next() * 0.05);
}
