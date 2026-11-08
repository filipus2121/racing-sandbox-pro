import { G, Rng, clamp, formatLap } from '../core/math.js';
import { CarSetup, Environment, PACE_CAR, defaultEnvironment, defaultSetup, effectiveMass } from '../physics/cars.js';
import { CarSpec } from '../physics/types.js';
import { CarInput, NO_INPUT, SurfaceSample, Vehicle, kmh, stepVehicle } from '../physics/vehicle.js';
import { Opponent, makeDrivers } from '../ai/opponent.js';
import { DEFAULT_FOLLOWS, RoadHint, newFollowState, followPoint } from '../ai/follow.js';
import { RacingLine, computeRacingLine, computeSpeedProfile } from '../track/racingLine.js';
import { PitLaneDef } from '../track/presets.js';
import { PointQuery, Track } from '../track/track.js';
import { PitLane, PitServiceView, PitState, describeService, newPitState, serviceDuration } from './pit.js';
import { RESTART_LATERALS, RaceControl, RaceControlConfig } from './raceControl.js';

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
  /** 0..1 crash damage. */
  damage: number;
  /** Out of the race: wrecked and parked. */
  retired: boolean;
  /** Currently in or entering pit road. */
  inPit: boolean;
  /** Laps down on the leader. */
  lapsDown: number;
}

export class Racer {
  readonly car: Vehicle;
  /**
   * The driver. Null for a human, and settable so a session can be run with the
   * player's car also under AI control - a full-field test needs every car
   * driving, and so does a spectator view.
   */
  opponent: Opponent | null;
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

  // ---- Damage and wrecks --------------------------------------------
  /** 0..1 overall crash damage. Above ~0.75 the car is out. */
  damage = 0;
  /** Steering pull from bent geometry, added to the driver's input. */
  damagePull = 0;
  /** 0..1 loss of engine power. */
  damageEngine = 0;
  /** 0..1 extra drag from a creased body. */
  damageDrag = 0;
  /** Spun and stopped: no longer driving, waiting to be cleared. */
  wrecked = false;
  wreckTime = 0;
  /** Out of the race entirely. */
  retired = false;
  /** Accumulated chance of losing it, per second. Filled by the AI's mistakes. */
  crashRisk = 0;
  /** Risk this driver has to reach before losing the car. Drawn per driver. */
  crashThreshold = 1;
  /** True between the crew finishing and the car leaving the stall. */
  pitRequestedService = false;

  // ---- Pit stops ------------------------------------------------------
  pit: PitState = newPitState();
  /** Live view of what the crew are doing, for the HUD and the animation. */
  pitView: PitServiceView | null = null;
  /** Laps since the last stop, for the AI's strategy. */
  lapsSincePit = 0;

  /** True for the pace car, which is on track but not in the race. */
  isPaceCar = false;
  /** Restart slot while the field is reforming, or -1. */
  slot = -1;
  /** Follow-controller state for non-racing driving. */
  follow = newFollowState();

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
  /**
   * False until the car has crossed the line once after the start. The grid
   * sits behind the start/finish line, so that first crossing begins lap 1
   * rather than completing a lap. Counting it used to credit every car with a
   * lap about a second into the race, which on a short event ended the race
   * before it had started and threw the white flag on lap one.
   */
  startLineArmed = false;
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
  /** Pit road, if the circuit has it. */
  pitDef?: PitLaneDef;
  /** Flags, pace car and overtime rules. */
  raceControl?: Partial<RaceControlConfig>;
  /** AI pit strategy: how many litres it wants to burn before stopping. */
  fuelWindowLaps?: number;
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
  flag: string;
  lapsToGo: number;
  cautionPhase: string;
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

  // ---- Race director, pit road, pace car, drafting ---------------------
  readonly rc: RaceControl;
  readonly pitLane: PitLane | null;
  /** The pace car. On track and simulated, but never in the standings. */
  paceCar: Racer | null = null;
  /** Drag multiplier per racer, from the draft. Index matches racers. */
  draftMod: number[] = [];
  /** Lateral pull from a side draft, m/s^2, index matches racers. */
  draftPull: number[] = [];
  /** Wreck debris on the track, for the renderer and for grip loss. */
  debris: { x: number; y: number; age: number; size: number }[] = [];
  /** Spotter radio, most recent last. */
  spotter: { t: number; text: string }[] = [];
  private lastSpotterAt = -10;
  private prevPaceS = 0;
  /** The pace car is on the racing surface and the field is queuing behind it. */
  paceCarOnTrack = false;
  /** The pace car is pulling off ahead of the restart. */
  paceCarPeeling = false;
  private paceCarOffTimer = 0;
  private lastFlagMessage = '';
  /** How many laps of fuel the AI plans to run between stops. */
  fuelWindowLaps: number;

  private accumulator = 0;
  private surfaces: SurfaceSample[] = [
    { ...defaultSurface() }, { ...defaultSurface() }, { ...defaultSurface() }, { ...defaultSurface() },
  ];

  constructor(config: WorldConfig) {
    this.track = config.track;
    this.env = { ...defaultEnvironment, ...config.env };
    this.sectorCount = config.sectorCount ?? 3;
    this.walled = config.walled ?? false;
    this.rng = new Rng(config.seed);
    this.rc = new RaceControl(
      { ...config.raceControl, laps: config.laps }, config.seed ^ 0x5eed,
    );
    this.pitLane = config.pitDef ? new PitLane(config.track, config.pitDef) : null;
    this.fuelWindowLaps = config.fuelWindowLaps ?? 0;

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
      // How much trouble a driver has to get into before it ends in the wall.
      // A wide spread matters more than the mean: one driver who never wrecks
      // and one who wrecks twice is what a real field looks like.
      r.crashThreshold = clamp(
        this.rng.range(0.35, 1.9) * (1.25 - drivers[i].consistency * 0.5), 0.15, 3);
      this.racers.push(r);
    }

    this.placeOnGrid();
    // An oval keeps its inside strip for pit road, so the racing line has to be
    // clamped to the racing band rather than to the full track width, or the AI
    // will treat the pit lane as part of the circuit.
    const band = config.pitDef
      ? { min: -config.track.width[0] * 0.5 + 0.9, max: config.pitDef.bandFrom - 1.0 }
      : undefined;
    this.line = computeRacingLine(this.track,
      { carHalfWidth: 1.0, margin: 0.8, ...(band ? { band } : {}) });
    this.recomputeSpeedProfile(config.aiLatG);
    this.draftMod = this.racers.map(() => 1);
    this.draftPull = this.racers.map(() => 0);
    if (this.rc.cfg.enablePaceCar) this.spawnPaceCar();
  }

  /**
   * Put the pace car on track. It sits just ahead of the leader at the leader's
   * speed and then settles down to pace speed.
   *
   * It is placed there rather than driving out of pit road because the two are
   * indistinguishable to the field: everyone lifts for the yellow at once, so a
   * pace car released from the pits at pace speed can never close on a leader
   * who is also held to pace speed. Starting it in front is the honest version
   * of "the pace car collects the field".
   */
  private spawnPaceCar(): void {
    const leader = this.racers[0];
    const spec = PACE_CAR;
    const setup = defaultSetup(spec);
    setup.fuelLoadL = spec.fuel.capacityL * 0.5;
    const r = new Racer(spec, setup, 'PACE CAR', 0, spec.bodyColor, false, null);
    r.isPaceCar = true;
    r.lastIndex = leader.lastIndex;
    const pose = this.track.pointAt(
      this.track.wrap(leader.trackS + 28), this.line.lateral[leader.lastIndex] ?? 0,
    );
    r.car.place(pose.x, pose.y, pose.heading, leader.car.speed);
    r.car.gear = 1;
    r.car.rpm = 2200;
    r.trackS = this.track.s[pose.index];
    this.paceCar = r;
    this.prevPaceS = r.trackS;
  }

  /** Derive the AI's speed profile from the cars on track. */
  recomputeSpeedProfile(latGOverride?: number): void {
    const ref = this.racers[1]?.car ?? this.player.car;
    const spec = ref.spec;
    const latG = latGOverride ?? clamp(
      (spec.tyreRear.muPeak * (effectiveMass(spec, ref.setup, 40) * G +
        (spec.aero.downforceFront100 + spec.aero.downforceRear100)) /
        // 0.64, not 0.82: measured on a steady 60 m circle the car holds
        // 1.02 g, while the raw muPeak formula here predicts 1.30 g. Feeding
        // the optimistic number to the AI makes it enter every corner about
        // 14% too fast and run off.
        effectiveMass(spec, ref.setup, 40)) / G * 0.64,
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
      // Same measured derate as the profile above.
      const lat = (s.tyreRear.muPeak * (m * G + df)) / m * 0.63;
      return {
        latAccel: lat,
        brakeAccel: lat * 0.95,
        accel: lat * 0.3,
        topSpeed: 100,
      };
    });
  }

  /**
   * Put everyone on the grid.
   *
   * A circuit with pit road is an oval, and an oval starts two abreast with the
   * rows packed close together rather than on the staggered road-course grid:
   * the whole point of a stock car start is that the field is level into turn 1.
   */
  placeOnGrid(): void {
    const oval = !!this.pitLane;
    this.racers.forEach((r, i) => {
      const pose = oval ? this.ovalGridPose(i) : this.track.gridPose(i, 7.5);
      r.car.place(pose.x, pose.y, pose.heading, 0);
      r.car.gear = 1;
      r.car.rpm = r.car.spec.engine.idleRpm;
      r.lastIndex = this.track.nearestIndex(pose.x, pose.y);
      r.trackS = this.track.s[r.lastIndex];
      r.sectorStart = this.time;
      r.lapStart = 0;
    });
  }

  /** Double-file grid slot: row 0 is the front row, inside car first. */
  private ovalGridPose(slot: number): { x: number; y: number; heading: number } {
    const row = Math.floor(slot / 2);
    const side = slot % 2;
    const s = this.track.wrap(this.track.totalLength - 12 - row * 9.5);
    return this.track.pointAt(s, RESTART_LATERALS[side]);
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
      r.startLineArmed = false;
      r.damage = 0;
      r.damagePull = 0;
      r.damageEngine = 0;
      r.damageDrag = 0;
      r.wrecked = false;
      r.wreckTime = 0;
      r.retired = false;
      r.crashRisk = 0;
      r.pit = newPitState();
      r.pitView = null;
      r.lapsSincePit = 0;
      r.slot = -1;
      r.car.dragMod = 1;
      r.car.gripMod = 1;
    }
    this.debris = [];
    this.spotter = [];
    this.rc.reset();
    this.pitLane?.clear();
    this.placeOnGrid();
    if (this.paceCar) {
      const leader = this.racers[0];
      const pose = this.track.pointAt(
        this.track.wrap(leader.trackS + 28), this.line.lateral[leader.lastIndex] ?? 0,
      );
      this.paceCar.car.place(pose.x, pose.y, pose.heading, 0);
      this.paceCar.trackS = this.track.s[pose.index];
      this.paceCar.lastIndex = pose.index;
      this.prevPaceS = this.paceCar.trackS;
    }
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
          // this.time, not 0: the formation countdown has already run, and
          // seeding 0 here charges the whole delay to the first lap.
          r.lapStart = this.time;
          r.sectorStart = this.time;
        }
      }
    }

    // Weather evolution.
    this.track.updateWeather(dt, this.env.rainMmH);

    // Aerodynamics between the cars, before anything reads the drag.
    this.updateDrafting();

    const inputs: CarInput[] = [];
    const othersInfo = this.racers.map(r => ({
      car: r.car,
      isPlayer: r.isPlayer,
      lapTime: r.bestLap || r.paceEstimate,
    }));
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      const q = this.track.query(r.car.x, r.car.y, r.lastIndex);
      const input: CarInput = r.isPlayer ? { ...playerInput } : { ...NO_INPUT };

      const controlled =
        this.driveWrecked(r, input) ||
        this.drivePit(r, i, q, dt, input) ||
        (!r.isPlayer && this.driveUnderCaution(r, i, dt, input));

      // A human drives themselves; anything with a driver attached is driven by
      // it, including the player's car in a full-field or spectator run.
      if (!controlled && r.opponent) {
        const lim = this.aiLimits[i] ?? this.aiLimits[0];
        r.opponent.update(r.car, this.track, this.line, this.speedLimit, dt,
          othersInfo.filter(o => o.car !== r.car), lim, input);
      }

      if (!this.started) {
        input.throttle = 0;
        input.brake = r.isPlayer ? Math.max(input.brake, 0.2) : 0.35;
      }
      // Damage pulls the car off line and robs the engine, whatever the driver
      // is asking for.
      if (r.damagePull !== 0) input.steer = clamp(input.steer + r.damagePull, -1, 1);
      if (r.damageEngine > 0) input.throttle *= 1 - r.damageEngine * 0.85;
      inputs.push(input);
    }

    // Surfaces under each wheel, then physics.
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      this.stepCar(r, inputs[i], dt);
    }
    // The pace car is simulated too, so the field can queue behind a real body
    // rather than an invisible speed limit.
    if (this.paceCar && this.paceCarOnTrack) this.stepPaceCar(dt);

    this.resolveCollisions(dt);
    this.updateDamage(dt);
    this.updateRaceControl(dt);
    this.updateFlags();
    this.updateSpotter(dt);

    // Session end: a stock car race is over when the leader is, not when the
    // last car home is - everybody else simply gets flagged off.
    if (!this.finished && (this.rc.raceOver || this.racers.every(r => r.finished))) {
      this.finished = true;
      this.push('Chequered flag - session complete', 'flag');
    }
  }

  /** One car's surface lookup, physics, boundary and timing. */
  private stepCar(r: Racer, input: CarInput, dt: number): void {
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
    car.dragMod = this.draftMod[this.racers.indexOf(r)] ?? 1;
    car.dragMod *= 1 + r.damageDrag;
    stepVehicle(car, input, this.env, dt);
    this.applyBoundary(r, dt);
    this.updateProgress(r, dt);
    // Rubber gets laid down where the tyres are working.
    const slip = Math.max(car.wheels[0].utilisation, car.wheels[1].utilisation,
      car.wheels[2].utilisation, car.wheels[3].utilisation);
    if (slip > 0.35 && this.surfaces[0].grip > 0.85) {
      this.track.addRubber(r.lastIndex, dt * 0.0035 * slip);
    }
  }

  /**
   * Drafting.
   *
   * A car in clean air pushes a hole in the atmosphere and pays for it. A car
   * two metres off somebody's bumper inherits that hole and pays much less,
   * which on a bluff-bodied stock car is worth twenty-odd kilometres an hour -
   * more than the engine can make up. This is the entire reason superspeedway
   * racing happens in packs, and without it an oval is a procession.
   *
   * There is also a small lateral pull towards the car ahead: the wake is a
   * low-pressure region and the nose is sucked into it, which is why running
   * nose-to-tail is twitchy and why a tow can drag you into the wall.
   */
  private updateDrafting(): void {
    for (let i = 0; i < this.racers.length; i++) {
      this.draftMod[i] = 1;
      this.draftPull[i] = 0;
    }
    for (let i = 0; i < this.racers.length; i++) {
      const a = this.racers[i];
      const cosH = Math.cos(a.car.heading);
      const sinH = Math.sin(a.car.heading);
      for (let j = 0; j < this.racers.length; j++) {
        if (i === j) continue;
        const b = this.racers[j];
        if (b.wrecked) continue;
        const dx = b.car.x - a.car.x;
        const dy = b.car.y - a.car.y;
        const along = dx * cosH + dy * sinH;
        const across = -dx * sinH + dy * cosH;
        if (along < 1.5 || along > 34) continue;
        const span = a.car.spec.halfWidth + b.car.spec.halfWidth + 1.4;
        if (Math.abs(across) > span) continue;
        const closeness = 1 - (along - 1.5) / 32.5;
        const alignment = 1 - Math.abs(across) / span;
        const effect = clamp(closeness * alignment, 0, 1);
        // Up to 30% off the drag, nose to tail.
        this.draftMod[i] = Math.min(this.draftMod[i], 1 - 0.3 * effect);
        // Suction towards the car ahead, scaled by speed: it is an aerodynamic
        // effect and does nothing at pit lane speed.
        const pull = -Math.sign(across) * effect * 0.55 * clamp(a.car.speed / 60, 0, 1);
        this.draftPull[i] += pull;
      }
      this.draftMod[i] = clamp(this.draftMod[i], 0.6, 1.15);
    }
    // Apply the lateral pull as a velocity nudge; it is a force on the body,
    // not something the tyres have to react to.
    for (let i = 0; i < this.racers.length; i++) {
      const pull = this.draftPull[i];
      if (pull === 0) continue;
      const a = this.racers[i].car;
      const cosH = Math.cos(a.heading);
      const sinH = Math.sin(a.heading);
      a.vx += -sinH * pull * PHYS_DT;
      a.vy += cosH * pull * PHYS_DT;
    }
  }

  /**
   * A wrecked car is not being driven any more. It comes to rest where it
   * stopped, and if the damage is terminal the driver gets out and it stays
   * there until the race is over.
   */
  private driveWrecked(r: Racer, input: CarInput): boolean {
    if (!r.wrecked) return false;
    input.throttle = 0;
    input.clutch = 1;
    input.shiftUp = false;
    input.shiftDown = false;
    input.handbrake = r.retired ? 1 : 0.4;
    if (r.retired || r.car.speed < 0.8) {
      input.brake = 1;
      input.steer = 0;
    } else {
      // Still rolling: straighten up and scrub the speed off.
      input.brake = 0.55;
      input.steer = clamp(-r.car.yawRate * 0.25, -1, 1);
    }
    return true;
  }

  /**
   * Pit road. Returns true while the lane owns the car.
   *
   * A human keeps the wheel but gets the limiter; the AI is driven to its stall
   * by the pit controller. Service only happens when the car is actually
   * stopped in a stall, which is the rule and also what keeps a car from
   * getting a four-tyre stop while still doing 200 km/h.
   */
  private drivePit(r: Racer, i: number, q: PointQuery, dt: number, input: CarInput): boolean {
    const lane = this.pitLane;
    if (!lane) return false;

    // ---- Service in progress ------------------------------------------
    if (r.pit.phase === 'atBox') {
      r.pit.serviceTime += dt;
      r.pitView = describeService(r.pit.serviceTime, r.pit.plan, r.pit.litres);
      if (r.pitView.stage === 'done') {
        this.finishStop(r);
      } else if (r.pitView.stage === 'jackDown' && !r.pitRequestedService) {
        // Tyres and fuel are delivered before the jacks drop, so the car is
        // already serviced by the time it comes down.
        this.applyService(r);
        r.pitRequestedService = true;
      }
      lane.drive(r.car, q.s, q.lateral, dt, r.pit, input, this.line.lateral[q.index] ?? 0,
        this.roadHint(q.index));
      return true;
    }

    // ---- Human driver in the lane: limiter and stall detection ----------
    if (r.isPlayer) {
      if (lane.inSpan(q.s) && lane.inBand(q.lateral)) {
        lane.limiter(r.car, input);
        if (r.pit.requested && r.car.speed < 0.8 && r.pit.phase === 'none') {
          this.beginStop(r, q);
        }
        if (r.pit.phase === 'none') return false;
      } else if (r.pit.phase === 'none') {
        return false;
      }
      return lane.drive(r.car, q.s, q.lateral, dt, r.pit, input,
        this.line.lateral[q.index] ?? 0, this.roadHint(q.index));
    }

    // ---- AI ---------------------------------------------------------
    if (r.pit.phase === 'none') {
      if (!r.pit.requested) return false;
      // Committed: head for the entry.
      r.pit.phase = 'toEntry';
      r.pit.box = lane.assign(i, lane.entryS + 40);
      if (r.pit.box < 0) {
        r.pit.requested = false;
        r.pit.phase = 'none';
        return false;
      }
    }
    return lane.drive(r.car, q.s, q.lateral, dt, r.pit, input,
      this.line.lateral[q.index] ?? 0);
  }

  /** Park the car in a stall and start the clock on the crew. */
  private beginStop(r: Racer, q: PointQuery): void {
    const lane = this.pitLane;
    if (!lane) return;
    if (r.pit.box < 0) r.pit.box = lane.assign(this.racers.indexOf(r), q.s);
    if (r.pit.box < 0) {
      r.pit.requested = false;
      return;
    }
    const pose = lane.boxPose(r.pit.box);
    r.car.place(pose.x, pose.y, pose.heading, 0);
    r.pit.phase = 'atBox';
    r.pit.serviceTime = 0;
    r.pit.litres = Math.max(0, r.car.spec.fuel.capacityL - r.car.fuelL);
    r.pitRequestedService = false;
    r.pitView = describeService(0, r.pit.plan, r.pit.litres);
    this.push(`${r.name} pits - ${r.pit.plan.tyres} tyres, ` +
      `${r.pit.litres.toFixed(0)}L (${serviceDuration(r.pit.plan, r.pit.litres).toFixed(1)}s)`, 'pit');
  }

  private applyService(r: Racer): void {
    const plan = r.pit.plan;
    if (plan.fuel) r.car.fuelL = r.car.spec.fuel.capacityL;
    const corners = plan.tyres === 4 ? [0, 1, 2, 3] : plan.tyres === 2 ? [1, 3] : [];
    const opt = r.car.spec.tyreRear.tempOpt;
    for (const c of corners) {
      const t = r.car.tyres[c];
      t.wear = 0;
      t.coreTemp = opt - 28;
      t.surfaceTemp = t.coreTemp;
    }
    // A stop is also the chance to fix what a crash broke, up to a point: the
    // crew can straighten a track bar but they cannot uncrease a splitter.
    r.damage = Math.max(0, r.damage - 0.18);
    r.damagePull *= 0.4;
  }

  private finishStop(r: Racer): void {
    const lane = this.pitLane;
    r.pit.phase = 'leaving';
    r.pit.serviceTime = 0;
    r.pitView = null;
    r.pit.count += 1;
    r.pit.requested = false;
    r.lapsSincePit = 0;
    if (r.pit.box >= 0) lane?.release(r.pit.box);
    this.push(`${r.name} rejoins after ${r.pit.count} stop${r.pit.count > 1 ? 's' : ''}`, 'pit');
  }

  /**
   * Driving under yellow.
   *
   * Lap 1 behind the pace car is single file. On lap 2 everybody is handed a
   * slot from the running order at the moment the yellow flew and has to get
   * into it, which is what "reform to double file" means: the order the race
   * was running is restored physically, not just on the scoring screen. Lap 3
   * holds that formation until the green.
   */
  private driveUnderCaution(r: Racer, i: number, dt: number, input: CarInput): boolean {
    if (!this.rc.underCaution) return false;
    if (r.wrecked) return false;
    const pace = this.paceCar;
    const paceSpeed = pace ? Math.max(24, pace.car.speed) : 30;

    // Reforming or holding: drive to the assigned slot.
    const slot = this.rc.slots.get(i);
    if ((this.rc.phase === 'reform' || this.rc.phase === 'hold') &&
      slot !== undefined && pace) {
      const pose = this.rc.slotPose(this.track, pace.trackS, slot);
      if (pose) {
        followPoint(r.car, pose.x, pose.y, Math.min(paceSpeed, 42), dt, r.follow, input,
          DEFAULT_FOLLOWS, this.roadHint(r.lastIndex));
        return true;
      }
    }

    // Single file: follow the car in front of us in the frozen order, or the
    // pace car if we are the first car behind it.
    const order = this.rc.frozenOrder;
    const pos = order.indexOf(i);
    let lead: Racer | null = pace;
    if (pos > 0) {
      const ahead = this.racers[order[pos - 1]];
      if (ahead && !ahead.wrecked) lead = ahead;
    } else if (pos < 0) {
      // Not in the frozen order (was already out): just hold a safe speed.
      lead = null;
    }
    if (!lead) {
      const pose = this.track.pointAt(
        this.track.wrap(r.trackS + 30), this.line.lateral[r.lastIndex] ?? 0,
      );
      followPoint(r.car, pose.x, pose.y, 30, dt, r.follow, input,
        DEFAULT_FOLLOWS, this.roadHint(r.lastIndex));
      return true;
    }
    const gap = clamp(12 + r.car.speed * 0.22, 12, 34);
    const cosH = Math.cos(lead.car.heading);
    const sinH = Math.sin(lead.car.heading);
    const tx = lead.car.x - cosH * gap;
    const ty = lead.car.y - sinH * gap;
    const target = clamp(lead.car.speed - (r.car.speed > lead.car.speed ? 2 : -1.5),
      18, paceSpeed + 6);
    followPoint(r.car, tx, ty, target, dt, r.follow, input,
      DEFAULT_FOLLOWS, this.roadHint(r.lastIndex));
    return true;
  }

  /**
   * Damage, wrecks and the (rare) mistakes that end a race.
   *
   * Crashes are driven by the AI's own error model rather than a flat timer:
   * risk only accumulates while a driver is simultaneously over the lateral
   * limit AND committing an error, which is exactly the situation a real wreck
   * comes from. Calibrated to a couple of cautions over a 20 lap run, so they
   * are a feature of the race rather than a metronome.
   */
  private updateDamage(dt: number): void {
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (r.retired || r.wrecked) {
        r.wreckTime += dt;
        continue;
      }
      // Grip falls off with damage: bent geometry and a damaged splitter.
      r.car.gripMod = clamp(1 - r.damage * 0.42, 0.45, 1);

      const opp = r.opponent;
      if (!opp) continue;
      const over = clamp(r.car.outOfGrip - 0.92, 0, 1.4);
      const mistake = Math.abs(opp.debug.mistake);
      if (over > 0.01 && mistake > 0.02 && r.car.speed > 12) {
        // Hazard per second of gated time. 0.012 with the gate open about 1% of
        // a lap works out near one wreck every seven races per driver.
        r.crashRisk += dt * 0.012 * (0.4 + Math.min(2.2, mistake * 7)) *
          Math.min(1, over * 3.5) * (1.35 - opp.profile.consistency);
      } else {
        // Get it back and the risk bleeds away; a driver who saves it does not
        // carry the near miss into the next corner.
        r.crashRisk = Math.max(0, r.crashRisk - dt * 0.02);
      }
      if (r.crashRisk >= r.crashThreshold && this.rng.chance(0.35)) {
        this.wreck(r, 'lost it');
      }
    }
  }

  /**
   * Peak and count of car-to-car impulses, N s. Kept because the contact-wreck
   * threshold has to sit above what a normal pack start produces, and guessing
   * that number is how a race ends in eight wrecks on lap one.
   */
  maxContactImpulse = 0;
  contactCount = 0;

  /** Every wreck, in order, for the summary and for tuning the crash rate. */
  readonly wreckLog: {
    t: number; name: string; reason: string; kmh: number; damage: number; lateral: number;
  }[] = [];

  /** Put a car out of shape and out of the race. */
  wreck(r: Racer, reason: string): void {
    if (r.wrecked || r.retired) return;
    r.wrecked = true;
    this.wreckLog.push({
      t: this.time, name: r.name, reason,
      kmh: r.car.speed * 3.6, damage: r.damage,
      lateral: this.track.query(r.car.x, r.car.y, r.lastIndex).lateral,
    });
    r.wreckTime = 0;
    r.crashRisk = 0;
    r.damage = Math.min(1, Math.max(r.damage, 0.55));
    // The classic stock car wreck is a spin, not a stop: kill the forward
    // speed and put a big yaw rate on it.
    r.car.yawRate += (this.rng.next() < 0.5 ? 1 : -1) * this.rng.range(0.5, 1.3);
    r.car.vx *= 0.55;
    r.car.vy *= 0.55;
    if (r.damage > 0.82) r.retired = true;
    for (let k = 0; k < 8; k++) {
      this.debris.push({
        x: r.car.x + this.rng.range(-4, 4),
        y: r.car.y + this.rng.range(-4, 4),
        age: 0, size: this.rng.range(0.4, 1.6),
      });
    }
    this.push(`BIG ONE - ${r.name} ${reason}`, 'crash');
  }

  /** Flags, the pace car and the restart. */
  private updateRaceControl(dt: number): void {
    void dt;
    const rc = this.rc;

    // ---- The pace car drives a lap at a time --------------------------
    const pace = this.paceCar;
    if (pace && this.paceCarOnTrack) {
      rc.updatePaceProgress(pace.trackS, this.prevPaceS, this.track.totalLength);
      this.prevPaceS = pace.trackS;
      if (rc.shouldPeel()) this.paceCarPeeling = true;
    }

    // ---- Throw a yellow when something is stopped on the racing surface --
    if (rc.isRacing && this.started) {
      for (const r of this.racers) {
        if (!r.wrecked) continue;
        const q = this.track.query(r.car.x, r.car.y, r.lastIndex);
        const inTheWay = Math.abs(q.lateral) < this.track.width[q.index] * 0.5 &&
          r.wreckTime > 1.2;
        if (inTheWay || r.retired) {
          rc.throwCaution(this.time, `${r.name} in the wall`, this.currentOrder());
          this.push(rc.lastMessage, 'flag');
          this.deployPaceCar();
          break;
        }
      }
    }
    if (rc.lastMessage && rc.lastMessage !== this.lastFlagMessage) {
      this.lastFlagMessage = rc.lastMessage;
      if (rc.flag === 'green' && rc.phase === 'none' && this.started) {
        this.push(rc.lastMessage, 'flag');
      }
    }

    // ---- Retire the wrecked once they are out of the way ---------------
    for (const r of this.racers) {
      if (r.wrecked && !r.retired && r.wreckTime > 26) r.retired = true;
    }
  }

  /** Move the pace car in front of the leader when the yellow flies. */
  private deployPaceCar(): void {
    if (!this.paceCar) return;
    const leader = this.currentOrder()
      .map(i => this.racers[i]).find(r => r && !r.wrecked) ?? this.racers[0];
    const lat = clamp(this.line.lateral[leader.lastIndex] ?? -4, -6.5, -2);
    const pose = this.track.pointAt(
      this.track.wrap(leader.trackS + 26), lat,
    );
    this.paceCar.car.place(pose.x, pose.y, pose.heading,
      Math.max(30, leader.car.speed * 0.8));
    this.paceCar.car.gear = 3;
    this.paceCar.lastIndex = pose.index;
    this.paceCar.trackS = this.track.s[pose.index];
    this.prevPaceS = this.paceCar.trackS;
    this.paceCarOnTrack = true;
    this.paceCarPeeling = false;
    this.paceCarOffTimer = 0;
  }

  /** The pace car's own driver: hold the line at pace speed. */
  private stepPaceCar(dt: number): void {
    const pace = this.paceCar;
    if (!pace) return;
    const input: CarInput = { ...NO_INPUT };
    const rc = this.rc;
    const cruise = 32;
    let targetS: number;
    let targetLateral: number;
    let speed: number;

    if (this.paceCarPeeling && this.pitLane) {
      // Pull into pit road and out of the way before the green.
      const lane = this.pitLane;
      const toEntry = this.track.wrap(lane.exitS + 12 - pace.trackS);
      targetS = pace.trackS + Math.min(Math.max(16, toEntry), 60);
      const blend = clamp(1 - toEntry / 90, 0, 1);
      targetLateral = (this.line.lateral[pace.lastIndex] ?? 0) * (1 - blend) +
        lane.centreLateral * blend;
      speed = cruise;
      this.paceCarOffTimer += dt;
      if (this.paceCarOffTimer > 22) this.paceCarOnTrack = false;
    } else if (!rc.underCaution) {
      this.paceCarOnTrack = false;
      return;
    } else {
      targetS = pace.trackS + 26;
      targetLateral = this.line.lateral[pace.lastIndex] ?? -4;
      speed = cruise;
    }
    const pose = this.track.pointAt(this.track.wrap(targetS), targetLateral);
    followPoint(pace.car, pose.x, pose.y, speed, dt, pace.follow, input,
      DEFAULT_FOLLOWS, this.roadHint(pace.lastIndex));
    const before = pace.trackS;
    this.stepCarBody(pace, input, dt);
    // Crossing the line advances the caution protocol. Detected on the arc
    // coordinate rather than a timer so the restart always happens at the
    // start/finish line, wherever the pace car was when the yellow flew.
    if (pace.trackS < before - this.track.totalLength * 0.5 && this.rc.underCaution) {
      this.rc.paceCarLapDone(this.currentOrder());
      this.push(`Pace lap ${this.rc.paceLaps} - ${this.rc.lastMessage || 'hold'}`, 'flag');
    }
  }

  /** Surface + physics for a car that is not in the standings. */
  private stepCarBody(r: Racer, input: CarInput, dt: number): void {
    const car = r.car;
    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const pos = car.wheelPosition(wIdx);
      const c = Math.cos(car.heading);
      const s = Math.sin(car.heading);
      this.track.fillSurface(car.x + pos.x * c - pos.y * s,
        car.y + pos.x * s + pos.y * c, this.surfaces[wIdx], r.lastIndex, car.heading);
      car.setSurface(wIdx, this.surfaces[wIdx]);
    }
    stepVehicle(car, input, this.env, dt);
    const idx = this.track.nearestIndex(car.x, car.y, r.lastIndex);
    r.lastIndex = idx;
    const q = this.track.query(car.x, car.y, idx);
    r.trackS = q.s;
    // The pace car gets the same barrier as the field. Without it a car that is
    // not in `racers` is free to leave the circuit and never come back, which is
    // exactly what it did: it slid off the banking and ended up 400 m away with
    // the whole field waiting for a restart that could never happen.
    const limit = this.track.width[idx] * 0.5 + (this.walled ? 0.5 : this.track.margin);
    const absL = Math.abs(q.lateral);
    if (absL > limit) {
      const h = this.track.heading[idx];
      const nx = -Math.sin(h) * Math.sign(q.lateral);
      const ny = Math.cos(h) * Math.sign(q.lateral);
      car.x -= nx * (absL - limit);
      car.y -= ny * (absL - limit);
      const vIn = car.vx * nx + car.vy * ny;
      if (vIn > 0) {
        car.vx -= nx * vIn * 1.2;
        car.vy -= ny * vIn * 1.2;
        car.yawRate *= 0.8;
      }
    }
  }

  /** Road curvature and banking at a track index, for steering feedforward. */
  roadHint(index: number): RoadHint {
    return {
      curvature: this.line.curvature[index] ?? this.track.curvature[index] ?? 0,
      bank: this.track.bankAt(index),
    };
  }

  /** Running order as racer indices, leader first. */
  private currentOrder(): number[] {
    return this.racers
      .map((r, i) => ({ i, r }))
      .filter(e => !e.r.retired)
      .sort((a, b) => {
        if (a.r.lap !== b.r.lap) return b.r.lap - a.r.lap;
        return b.r.progressDistance - a.r.progressDistance;
      })
      .map(e => e.i);
  }

  /**
   * The spotter. Every stock car driver has somebody on the roof telling them
   * what they cannot see; on an oval where you are three-wide at 300 km/h it is
   * the only way to know whether there is room to move.
   */
  private updateSpotter(dt: number): void {
    void dt;
    const r = this.player;
    if (r.retired) return;
    if (this.time - this.lastSpotterAt < 2.2) return;
    const cosH = Math.cos(r.car.heading);
    const sinH = Math.sin(r.car.heading);
    let inside = false;
    let outside = false;
    let tight = false;
    for (const o of this.racers) {
      if (o === r || o.wrecked) continue;
      const dx = o.car.x - r.car.x;
      const dy = o.car.y - r.car.y;
      const along = dx * cosH + dy * sinH;
      const across = -dx * sinH + dy * cosH;
      if (Math.abs(along) > r.car.spec.halfLength * 2.6) continue;
      if (Math.abs(across) > 3.6) continue;
      if (across > 0) inside = true;
      else outside = true;
      if (Math.abs(across) < 1.9) tight = true;
    }
    let text = '';
    if (tight && inside && outside) text = 'Three wide, do not move';
    else if (tight) text = inside ? 'Inside, inside, inside!' : 'Outside, outside!';
    else if (inside && outside) text = 'Car inside, car outside';
    else if (inside) text = 'Inside line, he is there';
    else if (outside) text = 'Clear inside, one to your outside';
    if (!text) return;
    this.lastSpotterAt = this.time;
    this.spotter.push({ t: this.time, text });
    if (this.spotter.length > 6) this.spotter.shift();
  }

  /** Keep cars inside the track boundary (or let them run into the wall). */
  private applyBoundary(r: Racer, dt: number): void {
    const car = r.car;
    const idx = this.track.nearestIndex(car.x, car.y, r.lastIndex);
    r.lastIndex = idx;
    const q = this.track.query(car.x, car.y, idx);
    // With a wall the barrier IS the track edge. Using width/2 + margin puts it
    // 26 m out in the run-off, which on an oval means the SAFER barrier is
    // somewhere in the infield and the cars are free to wander off the racing
    // surface for most of a lap.
    const limit = this.track.width[idx] * 0.5 + (this.walled ? 0.5 : this.track.margin);
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
        // Scrubbing along the barrier bleeds speed and kills the spin. Both
        // have to be rates, not per-step factors: this runs at 500 Hz, so a
        // "6% per step" cut is a 0.03 s time constant and a "0.7 per step"
        // yaw damping is instantaneous. Written that way a single wheel
        // kissing the wall stopped the car dead and pinned it there with the
        // throttle wide open, which is what the pace car spent its caution
        // lap doing. Exponential form with a ~1 s time constant for a heavy
        // scrape instead.
        const scrape = Math.abs(car.vx * -ny + car.vy * nx);
        const scrub = Math.exp(-clamp(scrape * 0.05, 0, 2) * dt);
        car.vx *= scrub;
        car.vy *= scrub;
        car.yawRate *= Math.exp(-4 * dt);
        // SAFER barrier takes most of it, but a stock car into the wall at
        // superspeedway speed comes back bent. Damage scales with the square of
        // the closing speed, because that is what the energy does.
        const hit = clamp((vIntoWall * vIntoWall) / 900, 0, 0.62);
        if (hit > 0.005) {
          r.damage = clamp(r.damage + hit, 0, 1);
          r.damagePull = clamp(r.damagePull + (this.rng.next() - 0.5) * hit * 0.5, -0.35, 0.35);
          r.damageDrag = clamp(r.damageDrag + hit * 0.18, 0, 0.35);
          if (hit > 0.3 && this.rng.chance(0.5)) r.damageEngine = clamp(r.damageEngine + 0.2, 0, 0.9);
          for (let k = 0; k < 4; k++) {
            this.debris.push({
              x: car.x + this.rng.range(-2, 2), y: car.y + this.rng.range(-2, 2),
              age: 0, size: this.rng.range(0.3, 1.1),
            });
          }
        }
        if (r.damage > 0.82 && !r.wrecked) {
          this.wreck(r, 'into the fence');
        } else if (vIntoWall > 8 && this.time - r.lastWallMsg > 2) {
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
    // Keep the raw difference: the wrap-around that signals a lap crossing is
    // exactly the thing the normalisation below removes, so testing the
    // normalised value can never fire.
    const rawDelta = sNow - r.trackS;
    let delta = rawDelta;
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
    if (!r.finished && rawDelta < -this.track.totalLength * 0.5 && car.speed > 2) {
      if (!r.startLineArmed) {
        // Rolling off the grid: this crossing starts the clock on lap 1.
        r.startLineArmed = true;
        r.lapStart = this.time;
        r.sectorStart = this.time;
        r.sectorIndex = 0;
        r.sectorTimes = [];
        return;
      }
      // Elapsed time, not the start timestamp.
      const lapMs = (this.time - r.lapStart) * 1000;
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
      r.lapStart = this.time;
      r.sectorTimes = [];
      r.sectorIndex = 0;
      r.sectorStart = this.time;
      r.offTrackTime = 0;
      r.lapsSincePit += 1;
      r.opponent?.noteLapCompleted();
      this.updateAiPitStrategy(r);
      // Only the leader's laps move the flags. A car one lap down taking the
      // white flag line means nothing to the race.
      const isLeader = this.currentOrder()[0] === this.racers.indexOf(r);
      const msg = this.rc.lapCompleted(isLeader);
      if (msg) this.push(msg, 'flag');
      if (r.lap >= this.laps) {
        r.finished = true;
        r.finishTime = this.time;
        const pos = this.standings().findIndex(row => row.racer === r) + 1;
        this.push(`${r.name} finished P${pos}`, 'finish');
      }
    }
    r.lapStart += dt;

    // Pit road entry/exit detection for the human driver: the AI is driven in
    // by the pit controller, but a person has to be told when they are in the
    // complex so the limiter and the stall marker make sense.
    const lane = this.pitLane;
    r.inPit = !!lane && lane.inSpan(q.s) && lane.inBand(q.lateral) && r.pit.phase !== 'none';
    if (r.isPlayer && lane && r.pit.requested && lane.inSpan(q.s) && r.pit.phase === 'none') {
      r.pit.phase = 'toEntry';
    }
  }

  /**
   * When the AI decides to pit.
   *
   * Driven by fuel first and tyres second, checked once per lap so the decision
   * is stable, and skipped under green when the driver is in the top three and
   * would lose the lead for it - which is the actual trade a crew chief makes.
   */
  private updateAiPitStrategy(r: Racer): void {
    if (!this.pitLane || r.retired || r.wrecked) return;
    if (r.isPlayer && !r.opponent) return;
    if (r.pit.requested || r.pit.phase !== 'none') return;
    const fuelLeft = r.car.fuelL;
    const burnPerLap = Math.max(0.5, this.fuelPerLap(r));
    const lapsOfFuel = fuelLeft / burnPerLap;
    const wear = r.tyreWear;
    const needsFuel = lapsOfFuel < 2.6;
    const needsTyres = wear > 0.72 && r.lapsSincePit > 6;
    const damage = r.damage > 0.45;
    if (!needsFuel && !needsTyres && !damage) return;
    // Do not throw the race away: hold on if a stop would drop them out of the
    // lead group and they can genuinely make it around again.
    const order = this.currentOrder();
    const pos = order.indexOf(this.racers.indexOf(r));
    if (this.rc.isRacing && pos >= 0 && pos < 3 && !needsFuel && lapsOfFuel > 1.2) return;

    r.pit.requested = true;
    r.pit.plan = {
      fuel: needsFuel || lapsOfFuel < 12,
      tyres: needsTyres || damage ? 4 : (r.lapsSincePit > 18 ? 2 : 4),
    };
    this.push(`${r.name} to pit road - ` +
      `${r.pit.plan.tyres} tyres${r.pit.plan.fuel ? ' and fuel' : ''}`, 'pit');
  }

  /**
   * Litres this car burns per lap.
   *
   * fuel.burnRate is litres per kW per second, so litres/second is simply
   * power times burnRate - no unit factor. An extra 1000 here made a lap look
   * like it cost 1200 litres and sent the entire field down pit road on lap
   * one, which is the sort of error that reads as "the AI loves pitting".
   */
  private fuelPerLap(r: Racer): number {
    const spec = r.car.spec;
    // Rated burn at 60% of peak power over a nominal lap time.
    const lapSeconds = Math.max(20, this.aiPaceSeconds());
    const kw = spec.engine.peakTorque * spec.engine.peakRpm * Math.PI / 30000 * 0.6;
    return Math.max(1.5, kw * spec.fuel.burnRate * lapSeconds);
  }

  /** Lap time in seconds implied by the AI's own speed profile. */
  private aiPaceSeconds(): number {
    let t = 0;
    const n = this.speedLimit.length;
    if (!n) return 40;
    for (let i = 0; i < n; i += 4) {
      const j = (i + 4) % n;
      let ds = this.track.s[j] - this.track.s[i];
      if (ds <= 0) ds += this.track.totalLength;
      t += ds / Math.max(1, this.speedLimit[i]);
    }
    return Math.max(20, t);
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
        this.maxContactImpulse = Math.max(this.maxContactImpulse, impulse);
        if (impulse > 900) {
          this.contactCount++;
          const a = this.racers[i];
          const b = this.racers[j];
          a.collisions++;
          b.collisions++;
          // Rubbing is racing, but a big hit bends things. Scale by impulse
          // above the "that was just a nudge" threshold.
          // Rubbing is racing. Two 1540 kg cars have a reduced mass of 770 kg,
          // so impulse maps straight onto closing speed: 6600 Ns is a 31 km/h
          // nudge in the pack, which happens sixty times a race and ends
          // nobody's afternoon. 15000 Ns is a 70 km/h closing speed, which is
          // the big one. Threshold set from the measured impulse distribution
          // (peak 35800 Ns = 168 km/h) rather than by feel, because at the old
          // 6600 threshold a restart turned into an eight-car pile-up on
          // principle.
          const d = clamp((impulse - 2500) / 60000, 0, 0.28);
          a.damage = clamp(a.damage + d, 0, 1);
          b.damage = clamp(b.damage + d, 0, 1);
          if (impulse > 15000) {
            // The car already carrying damage is the one that lets go.
            const victim = a.damage >= b.damage ? a : b;
            this.wreck(victim, `collected by ${victim === a ? b.name : a.name}`);
          }
          this.push(`Contact: ${a.name} / ${b.name}`, 'incident');
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
    const leaderLaps = Math.max(0, ...this.racers.map(r => r.lap));
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
      damage: r.damage,
      retired: r.retired,
      inPit: r.inPit || r.pit.phase !== 'none',
      lapsDown: Math.max(0, leaderLaps - r.lap),
    }));
    if (this.rc.underCaution && this.rc.frozenOrder.length) {
      // Under yellow the field is frozen. Running the order off live progress
      // would show cars passing each other for position they are not allowed to
      // gain, and then snap it all back at the restart.
      const rank = new Map<number, number>();
      this.rc.frozenOrder.forEach((idx, i) => rank.set(idx, i));
      rows.sort((a, b) => {
        if (a.racer.retired && !b.racer.retired) return 1;
        if (b.racer.retired && !a.racer.retired) return -1;
        const ra = rank.get(this.racers.indexOf(a.racer));
        const rb = rank.get(this.racers.indexOf(b.racer));
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return b.progress - a.progress;
      });
    } else {
      rows.sort((a, b) => {
        if (a.retired && !b.retired) return 1;
        if (b.retired && !a.retired) return -1;
        if (a.finished && b.finished) return a.finishMs - b.finishMs;
        if (a.finished) return -1;
        if (b.finished) return 1;
        if (a.laps !== b.laps) return b.laps - a.laps;
        return b.progress - a.progress;
      });
    }
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
      flag: this.rc.flag,
      lapsToGo: this.rc.lapsToGo,
      cautionPhase: this.rc.phase,
    };
  }

  /**
   * Scheduled race distance. Owned by the race director, because
   * green-white-checkered extends it while the race is running.
   */
  get laps(): number {
    return this.rc.lapsScheduled;
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
    flag: string; lapsToGo: number; cautionPhase: string; cautionReason: string;
    pit: { phase: string; stage: string; remaining: number; progress: number;
      limiter: boolean; box: number } | null;
    spotter: string;
    damage: number; draft: number; position: number;
  } {
    const car = this.player.car;
    const p = this.player;
    const lane = this.pitLane;
    const last = this.rc.cautions[this.rc.cautions.length - 1];
    const idx = this.racers.indexOf(p);
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
      wear: p.tyreWear,
      temps: [...car.tyreTemps],
      fuel: car.fuelL,
      brakeTemp: car.brakeTemp,
      flag: this.rc.flag,
      lapsToGo: this.rc.lapsToGo,
      cautionPhase: this.rc.phase,
      cautionReason: last ? last.reason : '',
      pit: lane && p.pit.phase !== 'none' ? {
        phase: p.pit.phase,
        stage: p.pitView?.stage ?? 'approach',
        remaining: p.pitView?.remaining ?? 0,
        progress: p.pitView?.progress ?? 0,
        limiter: lane.inSpan(this.track.query(car.x, car.y, p.lastIndex).s),
        box: p.pit.box,
      } : null,
      spotter: this.spotter.length ? this.spotter[this.spotter.length - 1].text : '',
      damage: p.damage,
      draft: 1 - (this.draftMod[idx] ?? 1),
      position: this.standings().findIndex(row => row.racer === p) + 1,
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
