import { DEG, Rng, clamp } from '../core/math.js';
import { CarInput, Vehicle, kmh } from '../physics/vehicle.js';
import { Track } from '../track/track.js';
import { RacingLine } from '../track/racingLine.js';

export interface DriverProfile {
  name: string;
  /** 0.82 .. 0.995: how much of the car's real capability the driver uses. */
  skill: number;
  /** 0 .. 1: extra pace taken, how hard they fight for position. */
  aggression: number;
  /** 0 .. 1: how repeatable their laps are (low = error prone). */
  consistency: number;
  /** 0 .. 1: how much they back off to save tyres. */
  tyreSaving: number;
  /** <1 brakes earlier, >1 brakes later. */
  bravery: number;
  nationality: string;
  number: number;
  color: string;
}

export const AI_NAMES: { name: string; nationality: string }[] = [
  { name: 'K. Virtanen', nationality: 'FIN' },
  { name: 'M. Okabe', nationality: 'JPN' },
  { name: 'L. Ferreira', nationality: 'BRA' },
  { name: 'T. Aldridge', nationality: 'GBR' },
  { name: 'S. Novak', nationality: 'CZE' },
  { name: 'R. Delacroix', nationality: 'FRA' },
  { name: 'A. Kovalenko', nationality: 'UKR' },
  { name: 'J. Marchetti', nationality: 'ITA' },
  { name: 'P. Vandenberg', nationality: 'NED' },
  { name: 'D. Sorensen', nationality: 'DEN' },
  { name: 'H. Bergstrom', nationality: 'SWE' },
  { name: 'C. Ibarra', nationality: 'ESP' },
  { name: 'N. Petrosyan', nationality: 'ARM' },
  { name: 'W. Zielinski', nationality: 'POL' },
  { name: 'E. Thorne', nationality: 'AUS' },
  { name: 'G. Haugen', nationality: 'NOR' },
];

export const AI_COLORS = [
  '#4ec9b0', '#c586c0', '#dcdcaa', '#9cdcfe', '#f48771', '#b5cea8',
  '#ce9178', '#569cd6', '#d7ba7d', '#c8c8c8', '#e07b53', '#7fd1ae',
  '#a9c7ff', '#ffd479', '#c0a0ff', '#8fd694',
];

export function makeDrivers(count: number, rng: Rng, spread = 0.06): DriverProfile[] {
  const names = [...AI_NAMES];
  const out: DriverProfile[] = [];
  for (let i = 0; i < count; i++) {
    const pick = names.splice(Math.floor(rng.next() * names.length) % names.length, 1)[0] ??
      { name: `Driver ${i + 1}`, nationality: '---' };
    const skill = clamp(0.985 - i * spread / Math.max(1, count) + rng.range(-0.01, 0.01),
      0.82, 0.995);
    out.push({
      name: pick.name,
      nationality: pick.nationality,
      number: 2 + i * 3 + Math.floor(rng.next() * 2),
      skill,
      aggression: clamp(rng.range(0.25, 0.95), 0, 1),
      consistency: clamp(rng.range(0.55, 0.98), 0, 1),
      tyreSaving: clamp(rng.range(0, 0.9), 0, 1),
      bravery: clamp(rng.range(0.88, 1.12), 0.7, 1.3),
      color: AI_COLORS[i % AI_COLORS.length],
    });
  }
  return out;
}

export interface OpponentDebug {
  targetX: number;
  targetY: number;
  targetSpeed: number;
  speedLimitAt: number;
  lineOffset: number;
  slipError: number;
  mistake: number;
  tyreScale: number;
  note: string;
}

/**
 * A racing driver, not a trajectory follower. The opponent looks at the same
 * world the human sees, picks a target point on its line, and drives the
 * actual vehicle model with throttle, brake, steering and gears. It can lock
 * up, spin, overheat its tyres, get held up in traffic and make mistakes.
 */
export class Opponent {
  readonly profile: DriverProfile;
  readonly rng: Rng;
  readonly debug: OpponentDebug;

  /** Current lateral offset applied to the racing line, m. */
  private lineOffset = 0;
  private lineOffsetTarget = 0;
  private lineChangeCooldown = 0;

  private noisePhase = 0;
  private mistakeTimer = 0;
  private mistakeKind = 0;
  private mistakeMag = 0;
  private nextMistakeIn = 20;
  private fatigue = 0;

  private smoothSteer = 0;
  private smoothThrottle = 0;
  private smoothBrake = 0;
  private gearHold = 0;

  /** Perceived fraction of the car's grip (a driver never knows it exactly). */
  private gripPerception = 1;

  constructor(profile: DriverProfile, seed: number) {
    this.profile = profile;
    this.rng = new Rng(seed);
    this.gripPerception = clamp(profile.skill + this.rng.range(-0.02, 0.02), 0.7, 1.05);
    this.nextMistakeIn = this.rng.range(8, 26);
    this.debug = {
      targetX: 0, targetY: 0, targetSpeed: 0, speedLimitAt: 0,
      lineOffset: 0, slipError: 0, mistake: 0, tyreScale: 1, note: '',
    };
  }

  /** Called once per lap-ish interval; models tyre care and fuel saving. */
  noteLapCompleted(): void {
    this.fatigue = clamp(this.fatigue + 0.02 * (1 - this.profile.consistency), 0, 0.25);
  }

  update(
    car: Vehicle,
    track: Track,
    line: RacingLine,
    speedLimit: number[],
    dt: number,
    others: { car: Vehicle; isPlayer: boolean; lapTime: number }[],
    limits: { latAccel: number; brakeAccel: number; accel: number; topSpeed: number },
    out: CarInput,
  ): void {
    const p = this.profile;
    const n = track.xs.length;
    const idx = track.nearestIndex(car.x, car.y);
    const q = track.query(car.x, car.y, idx);
    const speed = car.speed;
    const halfWidth = track.width[idx] * 0.5;

    // ---- Tyre state awareness ------------------------------------------
    const wear = (car.tyreWear[0] + car.tyreWear[1] + car.tyreWear[2] + car.tyreWear[3]) / 4;
    const tempAvg = (car.tyreTemps[0] + car.tyreTemps[1] + car.tyreTemps[2] + car.tyreTemps[3]) / 4;
    const tempOpt = car.spec.tyreRear.tempOpt;
    const tempBand = car.spec.tyreRear.tempBand;
    const dT = tempAvg - tempOpt;
    const tempScale = clamp(1 - 0.35 * (dT * dT) / (tempBand * tempBand * 4), 0.72, 1);
    const wearScale = 1 - wear * 0.45;
    let tyreScale = clamp(tempScale * wearScale, 0.5, 1);
    // A driver who saves tyres deliberately runs below the limit.
    tyreScale *= 1 - p.tyreSaving * 0.09;
    this.debug.tyreScale = tyreScale;

    // Grip actually available right now (surface, water, rubber).
    const surfaceScale = clamp(q.grip, 0.3, 1.35);
    const latAccel = limits.latAccel * this.gripPerception * tyreScale * surfaceScale;
    const brakeAccel = Math.max(3, limits.brakeAccel * this.gripPerception * tyreScale *
      surfaceScale);
    const accelCap = Math.max(1.5, limits.accel * this.gripPerception * tyreScale * surfaceScale);

    // ---- Line choice ------------------------------------------------------
    this.lineChangeCooldown = Math.max(0, this.lineChangeCooldown - dt);
    this.lineOffset += clamp(this.lineOffsetTarget - this.lineOffset, -2.5 * dt, 2.5 * dt);
    const baseLateral = line.lateral[idx] ?? 0;
    const wanted = clamp(baseLateral + this.lineOffset,
      -(halfWidth - 1.3), halfWidth - 1.3);

    // ---- Lookahead target --------------------------------------------------
    const lookahead = clamp(7 + speed * 0.62 + speed * speed * 0.0035, 8, 95);
    const targetIndex = this.advance(track, idx, lookahead);
    const th = track.heading[targetIndex];
    const tLat = clamp((line.lateral[targetIndex] ?? 0) + this.lineOffset * 0.85,
      -(track.width[targetIndex] * 0.5 - 1.3), track.width[targetIndex] * 0.5 - 1.3);
    const tx = track.xs[targetIndex] - Math.sin(th) * tLat;
    const ty = track.ys[targetIndex] + Math.cos(th) * tLat;
    this.debug.targetX = tx;
    this.debug.targetY = ty;

    // ---- Speed target with braking distance awareness ---------------------
    let vTarget = speedLimit[idx] ?? limits.topSpeed;
    // Scan forward: can we brake to the slowest point in time?
    const scanDist = clamp((speed * speed) / (2 * Math.max(2, brakeAccel)) + 30, 30, 400);
    let scanned = 0;
    let i = idx;
    let worst = Infinity;
    let worstDs = 0;
    while (scanned < scanDist) {
      const j = (i + 1) % n;
      let ds = track.s[j] - track.s[i];
      if (ds <= 0) ds += track.totalLength;
      scanned += ds;
      i = j;
      const lim = (speedLimit[i] ?? limits.topSpeed);
      // Max entry speed that still allows braking to lim over `scanned`.
      const allowable = Math.sqrt(Math.max(0, lim * lim + 2 * brakeAccel * p.bravery * scanned));
      if (allowable < worst) {
        worst = allowable;
        worstDs = scanned;
      }
    }
    vTarget = Math.min(vTarget, worst);
    // Personality: how close to the limit they actually drive.
    const push = p.skill * (1 + p.aggression * 0.05) * tyreScale;
    vTarget *= clamp(push, 0.6, 1.06);
    this.debug.targetSpeed = vTarget;
    this.debug.speedLimitAt = speedLimit[idx] ?? 0;
    void worstDs;

    // ---- Steering: slip-angle servo around the target --------------------
    const dx = tx - car.x;
    const dy = ty - car.y;
    const cosH = Math.cos(car.heading);
    const sinH = Math.sin(car.heading);
    const dLong = dx * cosH + dy * sinH;
    const dLat = -dx * sinH + dy * cosH;
    const desiredSlip = Math.atan2(dLat, Math.max(2, dLong));
    const actualSlip = Math.atan2(car.vyLocal, Math.max(0.6, car.vxLocal));
    const slipError = desiredSlip - actualSlip;
    this.debug.slipError = slipError;

    // Feedforward from the line curvature (bicycle model).
    const wheelbase = car.spec.wheelbase;
    const curvTarget = line.curvature[targetIndex] ?? 0;
    const vRef = Math.max(4, speed);
    const ff = Math.atan(wheelbase * curvTarget) *
      clamp(vRef * vRef / (wheelbase * Math.max(2, latAccel)), 0.15, 1.4);
    const kp = 1.5 + p.skill * 1.5;
    const kd = 0.22 + p.skill * 0.2;
    const yawErr = car.yawRate - vRef * curvTarget;
    let steer = clamp(ff + slipError * kp - yawErr * kd, -1, 1);

    // Driver noise + mistakes.
    this.noisePhase += dt * (1.4 + speed * 0.06);
    const noise = (Math.sin(this.noisePhase * 2.1) * 0.6 +
      Math.sin(this.noisePhase * 5.3 + 1.7) * 0.4) *
      (1 - p.skill) * 0.16 * (1 + this.fatigue);
    steer += noise;

    this.nextMistakeIn -= dt;
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      if (this.mistakeKind === 0) steer += this.mistakeMag;
    } else if (this.nextMistakeIn <= 0) {
      const chance = (1 - p.consistency) * 0.5 + this.fatigue;
      if (this.rng.chance(chance)) {
        this.mistakeKind = this.rng.next() < 0.65 ? 0 : 1;
        this.mistakeMag = (this.rng.range(0.1, 0.5)) * (1 - p.consistency * 0.5) *
          (this.rng.chance(0.5) ? 1 : -1);
        this.mistakeTimer = this.rng.range(0.15, 0.6);
        if (this.mistakeKind === 1) this.mistakeTimer *= 2.2;
      }
      this.nextMistakeIn = this.rng.range(9, 34) / Math.max(0.15, 1 - p.consistency * 0.6);
    }
    this.debug.mistake = this.mistakeTimer > 0 ? this.mistakeMag : 0;

    // Steering rate limit (a human cannot snap the wheel instantly).
    const maxRate = car.spec.steer.maxRate / Math.max(0.05, car.spec.steer.maxLock) * 0.85;
    steer = clamp(steer, this.smoothSteer - maxRate * dt, this.smoothSteer + maxRate * dt);
    this.smoothSteer = steer;

    // ---- Throttle / brake --------------------------------------------------
    const speedError = vTarget - speed;
    let throttle = 0;
    let brake = 0;
    if (speedError > 0.4) {
      throttle = clamp(speedError / Math.max(2, accelCap * 1.6), 0, 1);
      // Ease off when the car is already near its lateral limit.
      const latDemand = Math.abs(car.accelLat) / Math.max(1, latAccel);
      throttle *= clamp(1.25 - latDemand, 0.1, 1);
      // Traction management: lift when the driven wheels are spinning up.
      const slip = Math.max(Math.abs(car.wheels[2].slipRatio), Math.abs(car.wheels[3].slipRatio));
      const slipLimit = 0.1 + p.skill * 0.18;
      if (slip > slipLimit) throttle *= clamp(1 - (slip - slipLimit) * 5, 0, 1);
    } else if (speedError < -0.4) {
      const over = -speedError;
      brake = clamp(over / 9 + 0.12, 0.12, 1);
      // Trail-brake less as the corner loads up (real drivers do this).
      const latDemand = Math.abs(car.accelLat) / Math.max(1, latAccel);
      brake *= clamp(1.35 - latDemand * 0.85, 0.15, 1);
      // Mistake type 1 = brake far too late, or lock the fronts.
      if (this.mistakeTimer > 0 && this.mistakeKind === 1) brake = 1;
    } else {
      // Balanced: a little throttle to hold the line.
      const latDemand = Math.abs(car.accelLat) / Math.max(1, latAccel);
      throttle = clamp(0.22 - latDemand * 0.2, 0, 0.3);
    }
    // Never trail full brake and full throttle.
    if (brake > 0.05) throttle *= 0.1;

    this.smoothThrottle += clamp(throttle - this.smoothThrottle, -6 * dt, 4 * dt);
    this.smoothBrake += clamp(brake - this.smoothBrake, -9 * dt, 7 * dt);

    // ---- Gears ---------------------------------------------------------------
    this.gearHold = Math.max(0, this.gearHold - dt);
    let shiftUp = false;
    let shiftDown = false;
    if (this.gearHold <= 0) {
      const redline = car.spec.engine.redlineRpm;
      const upPoint = redline * (0.9 + (1 - p.skill) * 0.05);
      if (car.rpm > upPoint && car.gear >= 1 && car.gear < car.gearCount()) {
        shiftUp = true;
        this.gearHold = car.spec.engine.upshiftTime + 0.06;
      } else if (car.rpm < redline * 0.42 && car.gear > 1) {
        shiftDown = true;
        this.gearHold = car.spec.engine.downshiftTime + 0.08;
      } else if (car.gear === 0 && speed < 5) {
        shiftUp = true; // get off neutral at the start
        this.gearHold = 0.2;
      }
    }

    // ---- Traffic awareness -----------------------------------------------------
    let note = '';
    if (this.lineChangeCooldown <= 0) this.lineOffsetTarget *= 0.995;
    let nearestAhead = Infinity;
    let closingRate = 0;
    let sideSpaceLeft = halfWidth;
    let sideSpaceRight = halfWidth;
    for (const o of others) {
      if (o.car === car) continue;
      const ox = o.car.x - car.x;
      const oy = o.car.y - car.y;
      const along = ox * cosH + oy * sinH;
      const across = -ox * sinH + oy * cosH;
      const dist = Math.hypot(ox, oy);
      if (dist < 0.1) continue;
      const lateralRoom = Math.abs(across) - (car.spec.halfWidth + o.car.spec.halfWidth);
      // Ahead of us and roughly in our path.
      if (along > 0 && along < 70 && Math.abs(across) < halfWidth * 1.6) {
        if (along < nearestAhead) {
          nearestAhead = along;
          closingRate = Math.max(0, speed - o.car.speed);
        }
      }
      if (along > -3 && along < 12 && across > 0) sideSpaceLeft = Math.min(sideSpaceLeft, lateralRoom);
      if (along > -3 && along < 12 && across < 0) sideSpaceRight = Math.min(sideSpaceRight, lateralRoom);
      // Someone alongside: do not squeeze them, that is how incidents happen.
      if (along > -car.spec.halfLength * 2.2 && along < car.spec.halfLength * 2.2 &&
        Math.abs(across) < (car.spec.halfWidth + o.car.spec.halfWidth) * 2.1) {
        if (this.lineChangeCooldown <= 0) {
          this.lineOffsetTarget = clamp(this.lineOffset + (across > 0 ? -1.2 : 1.2),
            -(halfWidth - 1.4), halfWidth - 1.4);
          this.lineChangeCooldown = 0.7;
          note = 'hold line, car alongside';
        }
      }
      // Blue flag behaviour: faster car behind, give room.
      if (along < -4 && along > -45 && o.lapTime > 0 && o.lapTime < this.bestLapEstimate(track, line, speedLimit) * 0.985) {
        if (this.lineChangeCooldown <= 0) {
          const edge = across > 0 ? -(halfWidth - 1.5) : halfWidth - 1.5;
          this.lineOffsetTarget = clamp(edge - baseLateral, -(halfWidth - 1.4), halfWidth - 1.4);
          this.lineChangeCooldown = 1.4;
          note = 'blue flag: giving room';
        }
      }
    }

    // Overtake: if we are clearly quicker and there is a gap, commit to a side.
    if (nearestAhead < 45 && closingRate > 2.5 && this.lineChangeCooldown <= 0) {
      const goLeft = sideSpaceLeft >= sideSpaceRight;
      const room = goLeft ? sideSpaceLeft : sideSpaceRight;
      if (room > 1.6 && this.rng.chance(0.35 + p.aggression * 0.5)) {
        const target = goLeft ? halfWidth - 1.5 : -(halfWidth - 1.5);
        this.lineOffsetTarget = clamp(target - baseLateral, -(halfWidth - 1.4), halfWidth - 1.4);
        this.lineChangeCooldown = this.rng.range(1.1, 2.6);
        note = `overtaking ${goLeft ? 'left' : 'right'}`;
      } else if (room <= 1.6) {
        // No room: back off and wait for a better place.
        note = 'waiting for a gap';
        // Cap, do not multiply: this runs every 500 Hz step, so a per-step
        // factor of 0.55 is a decay with a 3 ms time constant and pins the
        // throttle at zero instead of easing off it.
        this.smoothThrottle = Math.min(this.smoothThrottle, 0.45);
        this.smoothBrake = Math.max(this.smoothBrake,
          clamp(closingRate / 25, 0, 0.55));
      }
    }
    // Being held up by a slow car right in front: lift to avoid contact.
    if (nearestAhead < 12 && closingRate > 4) {
      this.smoothBrake = Math.max(this.smoothBrake, clamp(closingRate / 12, 0.15, 0.8));
      this.smoothThrottle = Math.min(this.smoothThrottle, 0.3);
      note = 'avoiding contact';
    }
    this.debug.note = note;
    this.debug.lineOffset = this.lineOffset;

    // ---- Off-track recovery ----------------------------------------------------
    if (!q.onTrack) {
      // Steer back towards the tarmac, do not just keep pushing.
      const back = -Math.sign(q.lateral) * clamp(Math.abs(q.lateral) / 6, 0.1, 0.6);
      steer = clamp(steer * 0.5 + back, -1, 1);
      // Write to the smoothed values, since out.throttle reads those and the
      // local `throttle` is already spent -- but cap rather than multiply,
      // because a per-step factor at 500 Hz zeroes the throttle instantly and
      // the car then cannot drive back onto the tarmac at all.
      this.smoothThrottle = Math.min(this.smoothThrottle, 0.5);
      this.debug.note = 'off track, recovering';
    }

    // Keep the car pointed the right way if it ends up backwards.
    const headingError = Math.abs(((q.heading - car.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (headingError > Math.PI * 0.6 && speed < 14) {
      // Turn around by driving, not by braking. Stopping dead is a deadlock:
      // with no forward speed the steered wheels generate no lateral force,
      // so the heading error can never shrink and the car sits there forever.
      // A little throttle keeps the car rolling in a tight arc until it comes
      // back onto the racing direction.
      this.smoothThrottle = Math.max(this.smoothThrottle, 0.45);
      this.smoothBrake = 0;
      const dir = Math.sign(
        Math.sin(((q.heading - car.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) || 1;
      steer = clamp(dir, -1, 1);
      this.debug.note = 'turned around';
    }

    out.throttle = clamp(this.smoothThrottle, 0, 1);
    out.brake = clamp(this.smoothBrake, 0, 1);
    out.steer = clamp(steer, -1, 1);
    out.clutch = 0;
    out.shiftUp = shiftUp;
    out.shiftDown = shiftDown;
    out.handbrake = 0;

    void wanted;
    void DEG;
  }

  /** Rough expectation of this driver's lap time, for blue-flag decisions. */
  bestLapEstimate(track: Track, line: RacingLine, speedLimit: number[]): number {
    let t = 0;
    const n = speedLimit.length;
    for (let i = 0; i < n; i += 4) {
      const j = (i + 4) % n;
      let ds = track.s[j] - track.s[i];
      if (ds <= 0) ds += track.totalLength;
      t += ds / Math.max(1, speedLimit[i]);
    }
    void line;
    return t / Math.max(0.7, this.profile.skill);
  }

  /** Advance an index by roughly `dist` metres along the centreline. */
  private advance(track: Track, index: number, dist: number): number {
    const n = track.xs.length;
    let remaining = dist;
    let i = index;
    let guard = 0;
    while (remaining > 0 && guard++ < 400) {
      const j = (i + 1) % n;
      let ds = track.s[j] - track.s[i];
      if (ds <= 0) ds += track.totalLength;
      remaining -= ds;
      i = j;
    }
    return i;
  }

  /** Human-readable state for the debug overlay. */
  describe(car: Vehicle): string {
    const d = this.debug;
    return `${this.profile.name}  ${kmh(car).toFixed(0)} km/h  ` +
      `tgt ${(d.targetSpeed * 3.6).toFixed(0)}  off ${d.lineOffset.toFixed(2)} m  ` +
      `tyres ${(d.tyreScale * 100).toFixed(0)}%  ${d.note}`;
  }
}
