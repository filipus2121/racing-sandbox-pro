import { clamp } from '../core/math.js';
import { CarInput, Vehicle } from '../physics/vehicle.js';
import { Track } from '../track/track.js';
import { PitLaneDef } from '../track/presets.js';
import { DEFAULT_FOLLOWS, FollowState, RoadHint, newFollowState, followPoint } from '../ai/follow.js';

/** What the crew is doing right now. Drives both the sim and the animation. */
export type PitStage =
  | 'idle' | 'approach' | 'settle' | 'jackUp' | 'rightTyres' | 'cross'
  | 'leftTyres' | 'fuel' | 'jackDown' | 'release' | 'done';

export interface PitServiceView {
  stage: PitStage;
  /** 0..1 through the whole stop, for progress bars. */
  progress: number;
  /** Car is off the ground on the jacks. */
  jacked: boolean;
  /** Wheels changed so far, 0..4. */
  tyresDone: number;
  /** Litres delivered so far. */
  fuelDelivered: number;
  /** Crew are at the car rather than standing at the wall. */
  crewIn: boolean;
  /** How much longer, seconds. */
  remaining: number;
}

/** Fuel delivered per second by the two-man can crew, L/s. */
export const FUEL_RATE = 8.0;
/** Seconds for a tyre changer to do one side (two wheels). */
export const SIDE_TIME = 3.4;
/** Seconds for the changer to cross under the car. */
export const CROSS_TIME = 1.1;
const SETTLE = 0.5;
const JACK_UP = 0.4;
const JACK_DOWN = 0.4;
const RELEASE = 0.3;

export interface PitServicePlan {
  /** Fill the cell to full. */
  fuel: boolean;
  /** 0 = no tyres, 2 = right side only, 4 = all round. */
  tyres: 0 | 2 | 4;
}

/** How long a stop takes, given how much fuel is going in. */
export function serviceDuration(plan: PitServicePlan, litres: number): number {
  const tyreTime = plan.tyres === 4 ? SIDE_TIME * 2 + CROSS_TIME
    : plan.tyres === 2 ? SIDE_TIME : 0;
  const fuelTime = plan.fuel ? Math.max(0, litres) / FUEL_RATE : 0;
  // The fueler works in parallel with the changers, so the stop is the longer
  // of the two plus the fixed ends, not the sum.
  const work = Math.max(tyreTime, fuelTime + 0.3);
  return SETTLE + JACK_UP + work + JACK_DOWN + RELEASE;
}

/**
 * Pure description of a stop at `t` seconds after the car came to rest.
 *
 * Kept as a pure function of time so the renderer and the simulation can never
 * disagree about what the crew are doing - the animation is not a separate
 * timeline that could drift away from the state the world believes in.
 */
export function describeService(
  t: number, plan: PitServicePlan, litres: number,
): PitServiceView {
  const total = serviceDuration(plan, litres);
  const fuelTime = plan.fuel ? Math.max(0, litres) / FUEL_RATE : 0;
  const work = Math.max(
    plan.tyres === 4 ? SIDE_TIME * 2 + CROSS_TIME : plan.tyres === 2 ? SIDE_TIME : 0,
    fuelTime + 0.3,
  );
  const tSettle = SETTLE;
  const tJackUp = tSettle + JACK_UP;
  const tWork = tJackUp + work;
  const tJackDown = tWork + JACK_DOWN;

  let stage: PitStage = 'settle';
  let tyresDone = 0;
  if (t < tSettle) {
    stage = 'settle';
  } else if (t < tJackUp) {
    stage = 'jackUp';
  } else if (t < tWork) {
    const into = t - tJackUp;
    if (plan.tyres === 4) {
      if (into < SIDE_TIME) { stage = 'rightTyres'; tyresDone = 2; }
      else if (into < SIDE_TIME + CROSS_TIME) { stage = 'cross'; tyresDone = 2; }
      else { stage = 'leftTyres'; tyresDone = 4; }
    } else if (plan.tyres === 2) {
      stage = 'rightTyres'; tyresDone = 2;
    } else {
      stage = 'fuel';
    }
  } else if (t < tJackDown) {
    stage = 'jackDown';
    tyresDone = plan.tyres;
  } else if (t < total) {
    stage = 'release';
    tyresDone = plan.tyres;
  } else {
    stage = 'done';
    tyresDone = plan.tyres;
  }

  const fuelWindow = Math.max(0, Math.min(t, tJackUp + fuelTime) - tJackUp);
  const jacked = t >= tJackUp && t < tJackDown;
  return {
    stage,
    progress: clamp(t / Math.max(0.001, total), 0, 1),
    jacked,
    tyresDone,
    fuelDelivered: plan.fuel ? fuelWindow * FUEL_RATE : 0,
    crewIn: t >= tSettle * 0.5 && t < tJackDown + RELEASE * 0.5,
    remaining: Math.max(0, total - t),
  };
}

export interface PitBox {
  index: number;
  /** Arc position of the stall, m. */
  s: number;
  /** Lateral centre of the stall, m. */
  lateral: number;
  /** Index into the world's racer list, or -1 when free. */
  occupant: number;
}

/** Per-car pit state, carried by the Racer. */
export interface PitState {
  phase: 'none' | 'toEntry' | 'inLane' | 'atBox' | 'leaving';
  box: number;
  plan: PitServicePlan;
  /** Seconds since the car stopped in the box. */
  serviceTime: number;
  /** Litres going in, fixed when the stop starts. */
  litres: number;
  /** Set when the driver asks for a stop. */
  requested: boolean;
  follow: FollowState;
  /** Stops completed. */
  count: number;
}

export function newPitState(): PitState {
  return {
    phase: 'none', box: -1, plan: { fuel: true, tyres: 4 }, serviceTime: 0,
    litres: 0, requested: false, follow: newFollowState(), count: 0,
  };
}

/**
 * Pit road: a strip of the inside of the front straight, with stalls along the
 * wall. It is part of the track surface rather than a separate ribbon so that
 * the existing boundary and collision code keeps working unchanged - the wall
 * between the lane and the racing surface is enforced by the racing band the
 * line and the AI are clamped to, and by the pit limiter.
 */
export class PitLane {
  readonly entryS: number;
  readonly exitS: number;
  readonly bandFrom: number;
  readonly bandTo: number;
  readonly speedLimit: number;
  readonly boxes: PitBox[] = [];
  readonly track: Track;

  constructor(track: Track, def: PitLaneDef) {
    this.track = track;
    this.entryS = def.entryS;
    this.exitS = def.exitS;
    this.bandFrom = def.bandFrom;
    this.bandTo = def.bandTo;
    this.speedLimit = def.speedLimitKmh / 3.6;
    const usable = def.exitS - def.entryS;
    const n = Math.max(1, def.boxes);
    for (let i = 0; i < n; i++) {
      // Stalls are packed from the entry end, each one long enough for a car
      // plus a little room for the crew to work.
      const s = def.entryS + 18 + (usable - 36) * (i / Math.max(1, n - 1));
      this.boxes.push({ index: i, s, lateral: (def.bandFrom + def.bandTo) / 2, occupant: -1 });
    }
  }

  get centreLateral(): number {
    return (this.bandFrom + this.bandTo) / 2;
  }

  /** Is this lateral position inside the lane? */
  inBand(lateral: number): boolean {
    return lateral >= this.bandFrom - 0.2 && lateral <= this.bandTo + 0.2;
  }

  /** Is this arc position inside the pit complex? */
  inSpan(s: number): boolean {
    return s >= this.entryS - 5 && s <= this.exitS + 5;
  }

  boxPose(i: number): { x: number; y: number; heading: number } {
    const b = this.boxes[clamp(i, 0, this.boxes.length - 1)];
    return this.track.pointAt(b.s, b.lateral);
  }

  /** Claim a stall. Prefers one near the entry so the driver covers less road. */
  assign(racerIndex: number, preferS: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (const b of this.boxes) {
      if (b.occupant >= 0) continue;
      const score = Math.abs(b.s - preferS) + (b.occupant >= 0 ? 1e6 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = b.index;
      }
    }
    if (best >= 0) this.boxes[best].occupant = racerIndex;
    return best;
  }

  release(box: number): void {
    const b = this.boxes[box];
    if (b) b.occupant = -1;
  }

  clear(): void {
    for (const b of this.boxes) b.occupant = -1;
  }

  /**
   * Drive a car through a stop. Returns true while the car is under pit
   * control, so the caller knows not to hand it a racing input.
   *
   * The car is stopped by holding it kinematically during service rather than
   * by asking the brakes to hold it: a brake-held car still creeps as the
   * pressure relaxes, and a car that drifts out of its stall walks into the
   * crew standing there.
   */
  drive(
    car: Vehicle,
    s: number,
    lateral: number,
    dt: number,
    pit: PitState,
    out: CarInput,
    racingLateral: number,
    road?: RoadHint,
  ): boolean {
    if (pit.phase === 'none') return false;

    const limit = this.speedLimit;

    if (pit.phase === 'atBox') {
      // Held still by the sim, not by the brakes.
      car.vx *= 1 - Math.min(1, dt * 24);
      car.vy *= 1 - Math.min(1, dt * 24);
      car.yawRate *= 1 - Math.min(1, dt * 20);
      out.throttle = 0;
      out.brake = 1;
      out.steer = 0;
      out.clutch = 1;
      out.shiftUp = false;
      out.shiftDown = false;
      out.handbrake = 1;
      return true;
    }

    let targetS: number;
    let targetLateral: number;
    let targetSpeed: number;

    if (pit.phase === 'toEntry') {
      // Still on the racing surface: aim at the entry, blending sideways.
      const dist = this.track.wrap(this.entryS - s);
      targetS = s + Math.min(Math.max(18, dist), 90);
      const blend = clamp(1 - dist / 180, 0, 1);
      targetLateral = lateral + (this.centreLateral - lateral) * blend;
      targetSpeed = dist > 120 ? car.speed : limit;
      if (dist < 8) pit.phase = 'inLane';
    } else if (pit.phase === 'inLane') {
      const box = this.boxes[pit.box];
      if (!box) {
        pit.phase = 'none';
        return false;
      }
      const toBox = this.track.wrap(box.s - s);
      if (toBox < 3.5 && toBox > -3.5) {
        // In the stall: stop.
        const pose = this.boxPose(pit.box);
        followPoint(car, pose.x, pose.y, 0, dt, pit.follow, out, DEFAULT_FOLLOWS, road);
        if (car.speed < 0.6) {
          pit.phase = 'atBox';
          pit.serviceTime = 0;
        }
        return true;
      }
      targetS = s + Math.min(Math.max(14, toBox), 60);
      targetLateral = this.centreLateral;
      targetSpeed = Math.min(limit, Math.sqrt(Math.max(0, 2 * 6.5 * Math.max(0, toBox))) + 2);
    } else {
      // leaving
      const past = this.track.wrap(s - this.exitS);
      if (past > 45) {
        pit.phase = 'none';
        pit.box = -1;
        return false;
      }
      const ramp = clamp(past / 45, 0, 1);
      targetS = s + 22;
      targetLateral = this.centreLateral + (racingLateral - this.centreLateral) * ramp;
      targetSpeed = limit + (limit * 1.9 - limit) * ramp;
    }

    const pose = this.track.pointAt(this.track.wrap(targetS), targetLateral);
    followPoint(car, pose.x, pose.y, targetSpeed, dt, pit.follow, out, DEFAULT_FOLLOWS, road);
    return true;
  }

  /** Apply the speed limiter to a human driver in the lane. */
  limiter(car: Vehicle, out: CarInput): boolean {
    if (car.speed <= this.speedLimit) return false;
    // Cut drive and add just enough brake to bleed the excess, the way a real
    // limiter does - not a hard stop.
    out.throttle = 0;
    out.brake = Math.max(out.brake, clamp((car.speed - this.speedLimit) * 0.06, 0.05, 0.5));
    return true;
  }
}
