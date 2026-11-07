import { G, Rng, clamp, formatLap } from '../core/math.js';
import { CarSetup, Environment, defaultEnvironment, defaultSetup, effectiveMass } from '../physics/cars.js';
import { CarSpec } from '../physics/types.js';
import { CarInput, NO_INPUT, SurfaceSample, Vehicle, kmh, stepVehicle } from '../physics/vehicle.js';
import { Opponent, makeDrivers } from '../ai/opponent.js';
import { RacingLine, computeRacingLine, computeSpeedProfile } from '../track/racingLine.js';
import { Track } from '../track/track.js';

export const PHYS_DT = 1 / 500;
export const MAX_SUBSTEPS = 12;

export interface LapRecord {
  ms: number;
  sectors: number[];
  valid: boolean;
}

export interface StandingRow {
  racer: Racer;
  position: number;
  laps: number;
  lastLap: number;
  bestLap: number;
  gapToLeader: number;
  gapToAhead: number;
  progress: number;
  finished: boolean;
  finishMs: number;
  tyreWear: number;
  tyreTemp: number;
}

export class Racer {
  readonly car: Vehicle;
  readonly opponent: Opponent | null;
  readonly name: string;
  readonly number: number;
  readonly color: string;
  readonly isPlayer: boolean;
  readonly classLabel: string;

  // Progress along the track
  trackS = 0;
  lastIndex = 0;
  lap = 0;
  lapStart = 0;
  lastLap = 0;
  bestLap = 0;
  sectorTimes: number[] = [];
  sectorStart = 0;
  lapHistory: LapRecord[] = [];
  progressDistance = 0;
  finished = false;
  finishTime = 0;
  totalDistance = 0;
  wrongWay = false;
  offTrack = false;

  // Incidents / penalties
  collisions = 0;
  offTrackTime = 0;
  timePenalty = 0;
  inPit = false;
  pitStopTimer = 0;
  pitStops = 0;
  bestSector = 0;
  lastValidLapIndex = 0;
  blueFlag = false;
  sectorIndex = 0;
  lastWallMsg = -10;
  /** For AI: rough estimate of their own pace. */
  paceEstimate = 0;

  constructor(
    spec: CarSpec, setup: CarSetup, name: string, num: number, color: string,
    isPlayer: boolean, opponent: Opponent | null,
  ) {
    this.car = new Vehicle(spec, setup);
    this.name = name;
    this.number = num;
    this.color = color;
    this.isPlayer = isPlayer;
    this.opponent = opponent;
    this.classLabel = spec.class;
  }

  get tyreWear(): number {
    const w = this.car.tyreWear;
    return (w[0] + w[1] + w[2] + w[3]) / 4;
  }

  get tyreTemp(): number {
    const t = this.car.tyreTemps;
    return (t[0] + t[1] + t[2] + t[3]) / 4;
  }

  get lapTimeCurrent(): number {
    return this.lapStart;
  }
}

export interface WorldConfig {
  track: Track;
  playerSpec: CarSpec;
  playerSetup: CarSetup;
  aiSpecs: CarSpec[];
  aiCount: number;
  laps: number;
  env: Environment;
  seed: number;
  /** Grip/accel limits used by the AI, per class. */
  aiLatG?: number;
  sectorCount?: number;
  /** False = open field, true = wall at the track boundary. */
  walled?: boolean;
}

export interface WorldSnapshot {
  time: number;
  standings: StandingRow[];
  leader: Racer | null;
  player: Racer;
  countdown: number;
  started: boolean;
  finished: boolean;
  rainMmH: number;
  trackTempC: number;
}

/**
 * The session: physics, timing, collisions, weather and the AI, all stepped
 * on one fixed timestep so a session is reproducible from its seed.
 */
export class World {
  readonly track: Track;
  readonly racers: Racer[] = [];
  readonly player: Racer;
  readonly rng: Rng;
  env: Environment;
  laps: number;
  sectorCount: number;
  walled: boolean;
  time = 0;
  countdown = 5;
  started = false;
  finished = false;
  line: RacingLine;
  speedLimit: number[] = [];
  /** Grip limits handed to the AI, derived from the cars they drive. */
  aiLimits: { latAccel: number; brakeAccel: number; accel: number; topSpeed: number }[] = [];
  fastestLap = { ms: 0, name: '' };
  messages: { t: number; text: string; kind: string }[] = [];

  private accumulator = 0;
  private surfaces: SurfaceSample[] = [
    { ...defaultSurface() }, { ...defaultSurface() }, { ...defaultSurface() }, { ...defaultSurface() },
  ];

  constructor(config: WorldConfig) {
    this.track = config.track;
    this.env = { ...defaultEnvironment, ...config.env };
    this.laps = config.laps;
    this.sectorCount = config.sectorCount ?? 3;
    this.walled = config.walled ?? false;
    this.rng = new Rng(config.seed);

    const drivers = makeDrivers(config.aiCount, this.rng.fork(7));
    this.player = new Racer(config.playerSpec, config.playerSetup, 'YOU', 1,
      config.playerSpec.bodyColor, true, null);
    this.racers.push(this.player);
    for (let i = 0; i < config.aiCount; i++) {
      const spec = config.aiSpecs[i % config.aiSpecs.length];
      const setup = defaultSetup(spec);
      setup.tcLevel = 0.25;
      setup.absLevel = 0.3;
      setup.fuelLoadL = spec.fuel.capacityL * 0.55;
      const opp = new Opponent(drivers[i], (config.seed + i * 1013) >>> 0);
      const r = new Racer(spec, setup, drivers[i].name, drivers[i].number,
        drivers[i].color, false, opp);
      this.racers.push(r);
    }

    this.placeOnGrid();
    this.line = computeRacingLine(this.track, { carHalfWidth: 1.0, margin: 0.8 });
    this.recomputeSpeedProfile(config.aiLatG);
  }

  /** Derive the AI's speed profile from the cars on track. */
  recomputeSpeedProfile(latGOverride?: number): void {
    const ref = this.racers[1]?.car ?? this.player.car;
    const spec = ref.spec;
    const latG = latGOverride ?? clamp(
      (spec.tyreRear.muPeak * (effectiveMass(spec, ref.setup, 40) * G +
        (spec.aero.downforceFront100 + spec.aero.downforceRear100)) /
        effectiveMass(spec, ref.setup, 40)) / G * 0.82,
      1.0, 4.5,
    );
    const decel = latG * G * 0.9;
    const accel = latG * G * 0.32;
    this.speedLimit = computeSpeedProfile(
      this.track, this.line, latG * G, decel, accel, 105,
    );
    this.aiLimits = this.racers.map(r => {
      const s = r.car.spec;
      const m = effectiveMass(s, r.car.setup, r.car.fuelL);
      const df = s.aero.downforceFront100 + s.aero.downforceRear100;
      const lat = (s.tyreRear.muPeak * (m * G + df)) / m * 0.9;
      return {
        latAccel: lat,
        brakeAccel: lat * 0.95,
        accel: lat * 0.3,
        topSpeed: 100,
      };
    });
  }

  /** Put everyone on a staggered grid behind the start line. */
  placeOnGrid(): void {
    this.racers.forEach((r, i) => {
      const pose = this.track.gridPose(i, 7.5);
      r.car.place(pose.x, pose.y, pose.heading, 0);
      r.car.gear = 1;
      r.car.rpm = r.car.spec.engine.idleRpm;
      r.lastIndex = this.track.nearestIndex(pose.x, pose.y);
      r.trackS = this.track.s[r.lastIndex];
      r.sectorStart = this.time;
      r.lapStart = 0;
    });
  }

  reset(): void {
    this.time = 0;
    this.countdown = 5;
    this.started = false;
    this.finished = false;
    this.messages = [];
    this.fastestLap = { ms: 0, name: '' };
    for (const r of this.racers) {
      r.lap = 0;
      r.lapStart = 0;
      r.lastLap = 0;
      r.bestLap = 0;
      r.lapHistory = [];
      r.progressDistance = 0;
      r.finished = false;
      r.finishTime = 0;
      r.totalDistance = 0;
      r.collisions = 0;
      r.offTrackTime = 0;
      r.timePenalty = 0;
      r.inPit = false;
      r.pitStops = 0;
      r.sectorTimes = [];
      r.sectorIndex = 0;
      r.sectorStart = 0;
      r.wrongWay = false;
      r.offTrack = false;
      r.lastWallMsg = -10;
    }
    this.placeOnGrid();
  }

  /** Player inputs for this frame (interpolated onto the fixed step). */
  update(dtSeconds: number, playerInput: CarInput): void {
    this.accumulator += Math.min(dtSeconds, 0.25);
    let steps = 0;
    while (this.accumulator >= PHYS_DT && steps < MAX_SUBSTEPS * 40) {
      this.step(PHYS_DT, playerInput);
      this.accumulator -= PHYS_DT;
      steps++;
    }
    if (this.accumulator > PHYS_DT * MAX_SUBSTEPS * 40) this.accumulator = 0;
  }

  private step(dt: number, playerInput: CarInput): void {
    this.time += dt;
    if (this.countdown > 0) {
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown === 0 && !this.started) {
        this.started = true;
        this.push('GREEN GREEN GREEN!', 'flag');
        for (const r of this.racers) {
          r.lapStart = 0;
          r.sectorStart = 0;
        }
      }
    }

    // Weather evolution.
    this.track.updateWeather(dt, this.env.rainMmH);

    // Build AI inputs.
    const inputs: CarInput[] = [];
    const othersInfo = this.racers.map(r => ({
      car: r.car,
      isPlayer: r.isPlayer,
      lapTime: r.bestLap || r.paceEstimate,
    }));
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (r.isPlayer) {
        const input: CarInput = { ...playerInput };
        if (!this.started) {
          // False start protection: no drive off the line before the lights.
          input.throttle = 0;
          input.brake = Math.max(input.brake, 0.2);
        }
        if (r.inPit) {
          input.throttle = Math.min(input.throttle, 0.15);
        }
        inputs.push(input);
      } else {
        const ai: CarInput = { ...NO_INPUT };
        const lim = this.aiLimits[i] ?? this.aiLimits[0];
        r.opponent?.update(r.car, this.track, this.line, this.speedLimit, dt,
          othersInfo.filter(o => o.car !== r.car), lim, ai);
        if (!this.started) {
          ai.throttle = 0;
          ai.brake = 0.35;
        }
        if (r.inPit) {
          ai.throttle = Math.min(ai.throttle, 0.12);
          ai.brake = Math.max(ai.brake, 0.1);
        }
        inputs.push(ai);
      }
    }

    // Surfaces under each wheel, then physics.
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      const car = r.car;
      for (let wIdx = 0; wIdx < 4; wIdx++) {
        const pos = car.wheelPosition(wIdx);
        const c = Math.cos(car.heading);
        const s = Math.sin(car.heading);
        const wx = car.x + pos.x * c - pos.y * s;
        const wy = car.y + pos.x * s + pos.y * c;
        this.track.fillSurface(wx, wy, this.surfaces[wIdx], r.lastIndex, car.heading);
        car.setSurface(wIdx, this.surfaces[wIdx]);
      }
      stepVehicle(car, inputs[i], this.env, dt);
      this.applyBoundary(r, dt);
      this.updateProgress(r, dt);
      // Rubber gets laid down where the tyres are working.
      const slip = Math.max(car.wheels[0].utilisation, car.wheels[1].utilisation,
        car.wheels[2].utilisation, car.wheels[3].utilisation);
      if (slip > 0.35 && this.surfaces[0].grip > 0.85) {
        this.track.addRubber(r.lastIndex, dt * 0.0035 * slip);
      }
    }

    this.resolveCollisions(dt);
    this.updateFlags();

    // Session end.
    if (!this.finished && this.racers.every(r => r.finished)) {
      this.finished = true;
      this.push('Chequered flag - session complete', 'flag');
    }
  }

  /** Keep cars inside the track boundary (or let them run into the wall). */
  private applyBoundary(r: Racer, dt: number): void {
    const car = r.car;
    const idx = this.track.nearestIndex(car.x, car.y, r.lastIndex);
    r.lastIndex = idx;
    const q = this.track.query(car.x, car.y, idx);
    const limit = this.track.width[idx] * 0.5 + this.track.margin;
    const absL = Math.abs(q.lateral);
    r.offTrack = !q.onTrack;
    if (r.offTrack) r.offTrackTime += dt;
    if (this.walled && absL > limit) {
      // Push back onto the track and kill the velocity component into the wall.
      const h = this.track.heading[idx];
      const nx = -Math.sin(h) * Math.sign(q.lateral);
      const ny = Math.cos(h) * Math.sign(q.lateral);
      const push = absL - limit;
      car.x -= nx * push;
      car.y -= ny * push;
      const vIntoWall = car.vx * nx + car.vy * ny;
      if (vIntoWall > 0) {
        car.vx -= nx * vIntoWall * 1.35;
        car.vy -= ny * vIntoWall * 1.35;
        const scrape = Math.abs(car.vx * -ny + car.vy * nx);
        car.vx *= 1 - clamp(scrape * 0.004, 0, 0.25);
        car.vy *= 1 - clamp(scrape * 0.004, 0, 0.25);
        car.yawRate *= 0.7;
        if (vIntoWall > 8 && this.time - r.lastWallMsg > 2) {
          r.lastWallMsg = this.time;
          this.push(`${r.name} into the wall (${(vIntoWall * 3.6).toFixed(0)} km/h)`, 'incident');
        }
      }
    }
  }

  /** Track progress, lap and sector timing, pit entry. */
  private updateProgress(r: Racer, dt: number): void {
    const car = r.car;
    const q = this.track.query(car.x, car.y, r.lastIndex);
    const sNow = q.s;
    let delta = sNow - r.trackS;
    if (delta > this.track.totalLength * 0.5) delta -= this.track.totalLength;
    if (delta < -this.track.totalLength * 0.5) delta += this.track.totalLength;
    r.wrongWay = delta < -0.02 && car.speed > 3;
    if (Math.abs(delta) < this.track.totalLength * 0.25) {
      r.progressDistance += delta;
    }
    r.trackS = sNow;
    r.totalDistance += car.speed * dt;

    // ---- Sector timing -------------------------------------------------
    const sectorLen = this.track.totalLength / this.sectorCount;
    const sectorIndex = Math.min(this.sectorCount - 1, Math.floor(q.s / sectorLen));
    if (!r.finished && sectorIndex !== r.sectorIndex) {
      // Only count a forward step into the next sector.
      const expected = (r.sectorIndex + 1) % this.sectorCount;
      if (sectorIndex === expected) {
        const sectorMs = (this.time - r.sectorStart) * 1000;
        if (sectorMs > 300 && sectorMs < 300000) {
          r.sectorTimes.push(sectorMs);
          if (r.bestSector === 0 || sectorMs < r.bestSector) r.bestSector = sectorMs;
        }
      }
      r.sectorIndex = sectorIndex;
      r.sectorStart = this.time;
    }

    // ---- Lap crossing: s wrapped past the start/finish line --------------
    if (!r.finished && delta < -this.track.totalLength * 0.5 && car.speed > 2) {
      const lapMs = r.lapStart * 1000;
      const valid = lapMs > 3000 && lapMs < 600000;
      if (valid) {
        r.lastLap = lapMs;
        if (r.bestLap === 0 || lapMs < r.bestLap) r.bestLap = lapMs;
        r.lapHistory.push({
          ms: lapMs,
          sectors: r.sectorTimes.slice(),
          valid: r.offTrackTime < 2 && r.collisions === 0,
        });
        r.lastValidLapIndex = r.lapHistory.length - 1;
        if (this.fastestLap.ms === 0 || lapMs < this.fastestLap.ms) {
          this.fastestLap = { ms: lapMs, name: r.name };
          this.push(`Fastest lap: ${r.name} ${formatLap(lapMs)}`, 'fastest');
        }
      }
      r.lap += 1;
      r.lapStart = 0;
      r.sectorTimes = [];
      r.sectorIndex = 0;
      r.sectorStart = this.time;
      r.offTrackTime = 0;
      r.opponent?.noteLapCompleted();
      if (r.lap >= this.laps) {
        r.finished = true;
        r.finishTime = this.time;
        const pos = this.standings().findIndex(row => row.racer === r) + 1;
        this.push(`${r.name} finished P${pos}`, 'finish');
      }
    }
    r.lapStart += dt;

    // Pit lane: a box just behind the start line on the inside.
    const inPitZone = q.s < 60 || q.s > this.track.totalLength - 60;
    if (inPitZone && Math.abs(q.lateral) > this.track.width[q.index] * 0.5 - 3 &&
      Math.abs(q.lateral) < this.track.width[q.index] * 0.5 + 4 && car.speed < 22) {
      if (!r.inPit) {
        r.inPit = true;
        r.pitStops += 1;
        this.push(`${r.name} pits`, 'pit');
      }
      r.pitStopTimer += dt;
      if (r.pitStopTimer > 3) {
        // Fresh tyres and a splash of fuel.
        for (const t of r.car.tyres) {
          t.wear = 0;
          t.coreTemp = r.car.spec.tyreRear.tempOpt - 25;
          t.surfaceTemp = t.coreTemp;
        }
        r.car.fuelL = Math.min(r.car.spec.fuel.capacityL, r.car.fuelL + 25);
        r.pitStopTimer = -999; // only service once per stop
      }
    } else {
      if (r.inPit) this.push(`${r.name} rejoins`, 'pit');
      r.inPit = false;
      r.pitStopTimer = Math.max(0, r.pitStopTimer);
    }
  }

  /** Simple but momentum-conserving car-car collisions. */
  private resolveCollisions(dt: number): void {
    void dt;
    const n = this.racers.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.racers[i].car;
        const b = this.racers[j].car;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = (a.spec.halfLength + b.spec.halfLength) * 0.52 +
          (a.spec.halfWidth + b.spec.halfWidth) * 0.5;
        if (dist >= minDist || dist < 1e-6) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const relNormal = rvx * nx + rvy * ny;
        const ma = a.mass;
        const mb = b.mass;
        const invA = 1 / ma;
        const invB = 1 / mb;
        const restitution = 0.16;
        let impulse = -(1 + restitution) * relNormal / (invA + invB);
        if (impulse < 0) impulse = 0;
        a.vx -= impulse * nx * invA;
        a.vy -= impulse * ny * invA;
        b.vx += impulse * nx * invB;
        b.vy += impulse * ny * invB;
        // Separate the overlap so they do not stick together.
        const overlap = minDist - dist;
        a.x -= nx * overlap * 0.5 * (invA / (invA + invB)) * 2;
        a.y -= ny * overlap * 0.5 * (invA / (invA + invB)) * 2;
        b.x += nx * overlap * 0.5 * (invB / (invA + invB)) * 2;
        b.y += ny * overlap * 0.5 * (invB / (invA + invB)) * 2;
        // Off-centre hits spin the cars.
        a.yawRate += (nx * -ny) * impulse * 0.00016;
        b.yawRate -= (nx * -ny) * impulse * 0.00016;
        if (impulse > 900) {
          this.racers[i].collisions++;
          this.racers[j].collisions++;
          this.push(`Contact: ${this.racers[i].name} / ${this.racers[j].name}`, 'incident');
        }
      }
    }
  }

  /** Blue flags for cars about to be lapped. */
  private updateFlags(): void {
    const leaderProgress = Math.max(...this.racers.map(r => r.progressDistance));
    for (const r of this.racers) {
      r.blueFlag = leaderProgress - r.progressDistance > this.track.totalLength * 0.85;
    }
  }

  standings(): StandingRow[] {
    const rows: StandingRow[] = this.racers.map(r => ({
      racer: r,
      position: 0,
      laps: Math.max(0, r.lap),
      lastLap: r.lastLap,
      bestLap: r.bestLap,
      gapToLeader: 0,
      gapToAhead: 0,
      progress: r.progressDistance,
      finished: r.finished,
      finishMs: r.finishTime,
      tyreWear: r.tyreWear,
      tyreTemp: r.tyreTemp,
    }));
    rows.sort((a, b) => {
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < rows.length; i++) {
      rows[i].position = i + 1;
      if (i > 0) {
        const speed = Math.max(8, rows[i].racer.car.speed);
        rows[i].gapToAhead = ((rows[i - 1].progress - rows[i].progress) / speed) * 1000;
        rows[i].gapToLeader = ((rows[0].progress - rows[i].progress) / speed) * 1000;
      }
    }
    return rows;
  }

  push(text: string, kind: string): void {
    this.messages.push({ t: this.time, text, kind });
    if (this.messages.length > 40) this.messages.shift();
  }

  snapshot(): WorldSnapshot {
    const rows = this.standings();
    return {
      time: this.time,
      standings: rows,
      leader: rows[0]?.racer ?? null,
      player: this.player,
      countdown: this.countdown,
      started: this.started,
      finished: this.finished,
      rainMmH: this.env.rainMmH,
      trackTempC: this.env.trackTempC,
    };
  }

  /** Lap time the player would need for pole, for the ghost/target display. */
  targetLapMs(): number {
    const best = Math.min(...this.racers.filter(r => r.bestLap > 0).map(r => r.bestLap),
      Infinity);
    return isFinite(best) ? best : 0;
  }

  /** Speed in km/h for the HUD, plus a few derived numbers. */
  hudData(): {
    speed: number; rpm: number; gear: number; throttle: number; brake: number;
    steer: number; latG: number; longG: number; slip: number; wear: number;
    temps: number[]; fuel: number; brakeTemp: number;
  } {
    const car = this.player.car;
    return {
      speed: kmh(car),
      rpm: car.rpm,
      gear: car.gear,
      throttle: car.throttleActual,
      brake: car.brakePressure,
      steer: car.steeringAngle,
      latG: car.accelLat / G,
      longG: car.accelLong / G,
      slip: car.outOfGrip,
      wear: this.player.tyreWear,
      temps: [...car.tyreTemps],
      fuel: car.fuelL,
      brakeTemp: car.brakeTemp,
    };
  }
}

function defaultSurface(): SurfaceSample {
  return {
    grip: 1, rollingResist: 0, waterDepth: 0, bank: 0,
    slopeAlong: 0, slopeAcross: 0, rubber: 0,
  };
}

/** Preset weather scenarios for the session menu. */
export const WEATHER_PRESETS: { id: string; label: string; env: Partial<Environment> }[] = [
  { id: 'dry-hot', label: 'Dry, hot track (45°C)', env: { trackTempC: 45, airTempC: 30, rainMmH: 0 } },
  { id: 'dry', label: 'Dry, mild (28°C)', env: { trackTempC: 28, airTempC: 20, rainMmH: 0 } },
  { id: 'cold', label: 'Dry, cold (14°C)', env: { trackTempC: 14, airTempC: 10, rainMmH: 0 } },
  { id: 'damp', label: 'Damp, drying', env: { trackTempC: 18, airTempC: 15, rainMmH: 0.4 } },
  { id: 'rain', label: 'Rain (8 mm/h)', env: { trackTempC: 16, airTempC: 14, rainMmH: 8 } },
  { id: 'storm', label: 'Heavy rain (20 mm/h)', env: { trackTempC: 15, airTempC: 13, rainMmH: 20 } },
];
