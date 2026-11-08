import { G, DEG, clamp } from '../core/math.js';
import { CarSetup, Environment } from './cars.js';
import { CarSpec } from './types.js';
import { TyreState, rollingRadius, tyreForces, tyreThermalStep } from './tire.js';

/** Wheel indices. */
export const FL = 0;
export const FR = 1;
export const RL = 2;
export const RR = 3;
export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;

export interface SurfaceSample {
  /** Grip multiplier relative to the reference surface. */
  grip: number;
  /** Extra rolling resistance coefficient for this surface. */
  rollingResist: number;
  /** Standing water depth, mm. */
  waterDepth: number;
  /** Track banking, rad (positive = banking lifts the left side). */
  bank: number;
  /** Track grade in the car's frame, rad. slopeAlong > 0 = uphill ahead. */
  slopeAlong: number;
  /** Cross slope (banking) in the car's frame; > 0 = surface falls to the left. */
  slopeAcross: number;
  /** Rubber/marbles grip modifier baked into the surface (0 = none). */
  rubber: number;
}

export const NEUTRAL_SURFACE: SurfaceSample = {
  grip: 1,
  rollingResist: 0,
  waterDepth: 0,
  bank: 0,
  slopeAlong: 0,
  slopeAcross: 0,
  rubber: 0,
};

export interface CarInput {
  throttle: number; // 0..1
  brake: number;    // 0..1
  steer: number;    // -1..1 (positive = left)
  clutch: number;   // 0..1 (1 = disengaged)
  shiftUp: boolean;
  shiftDown: boolean;
  handbrake: number; // 0..1, rear brake only
}

export const NO_INPUT: CarInput = {
  throttle: 0, brake: 0, steer: 0, clutch: 0,
  shiftUp: false, shiftDown: false, handbrake: 0,
};

export interface WheelRuntime {
  x: number;      // local position, m
  y: number;
  slipRatio: number;
  slipAngle: number;
  camber: number;
  fz: number;
  fx: number;
  fy: number;
  mu: number;
  /** 0..1+, how much of the friction budget is used. */
  utilisation: number;
  brakeTorque: number;
  driveTorque: number;
  spin: boolean;
  locked: boolean;
  offTrack: boolean;
  waterDepth: number;
  grip: number;
}

export class Vehicle {
  readonly spec: CarSpec;
  setup: CarSetup;

  // Body state
  x = 0;
  y = 0;
  vx = 0; // world velocity
  vy = 0;
  heading = 0;
  yawRate = 0;
  vxLocal = 0; // body-frame velocity (x forward, y left)
  vyLocal = 0;
  speed = 0;

  // Vertical / chassis state
  zVel = 0;
  zOff = 0; // sprung mass vertical offset from static, m
  pitchRate = 0;
  rollRate = 0;
  rollAngle = 0;
  pitchAngle = 0;
  cgHeight = 0.3;

  // Wheels
  readonly tyres: TyreState[] = [];
  readonly wheels: WheelRuntime[] = [];
  readonly wheelSurface: SurfaceSample[] = [];

  // Drivetrain
  rpm: number;
  gear = 0; // 1-based; 0 = neutral, -1 = reverse
  engineTorque = 0;
  throttleActual = 0;
  brakePressure = 0;
  brakePedal = 0;
  shiftTimer = 0;
  wheelspin = 0;
  wheelTorqueDrive = 0;
  clutchSlip = 0;
  /** Per-wheel ABS pressure modulator, 0..1. */
  readonly absPressure = [1, 1, 1, 1];
  slipAngleBody = 0;

  // Thermal
  brakeTemp = 60;
  engineTemp = 90;

  // Resources
  fuelL: number;
  distance = 0;

  // Telemetry (last computed step)
  accelLong = 0;
  accelLat = 0;
  downforce = 0;
  dragForce = 0;
  /**
   * Multiplier on aerodynamic drag, set by the session rather than the driver.
   * Below 1 when the car is in somebody's draft - the wake of the car ahead
   * removes a large part of the pressure drag, which on a bluff-bodied stock
   * car is worth more than twenty kilometres an hour and is the entire reason
   * superspeedway racing happens in packs.
   */
  dragMod = 1;
  /**
   * Multiplier on available tyre grip, set by the session. Below 1 when the car
   * is carrying damage: a bent track bar or a creased splitter does not remove
   * grip evenly, but scaling the friction budget is the honest first-order
   * model of it.
   */
  gripMod = 1;
  mass = 620;
  tyreTemps = [0, 0, 0, 0];
  tyreWear = [0, 0, 0, 0];
  suspensionLoad = [0, 0, 0, 0];
  steeringAngle = 0;
  steeringTorque = 0;
  outOfGrip = 0;

  constructor(spec: CarSpec, setup: CarSetup) {
    this.spec = spec;
    this.setup = setup;
    this.fuelL = setup.fuelLoadL;
    this.rpm = spec.engine.idleRpm;
    const startTemp = spec.tyreFront.tempOpt - 25;
    for (let i = 0; i < 4; i++) {
      this.tyres.push({
        coreTemp: startTemp,
        surfaceTemp: startTemp,
        wear: 0,
        omega: 0,
        slipEnergy: 0,
        relaxedSlipAngle: 0,
        relaxedSlipRatio: 0,
      });
      this.wheels.push({
        x: 0, y: 0, slipRatio: 0, slipAngle: 0, camber: 0, fz: 0, fx: 0, fy: 0,
        mu: 1, utilisation: 0, brakeTorque: 0, driveTorque: 0, spin: false,
        locked: false, offTrack: false, waterDepth: 0, grip: 1,
      });
      this.wheelSurface.push({ ...NEUTRAL_SURFACE });
      this.tyreTemps[i] = startTemp;
    }
    this.cgHeight = spec.cgHeight;
  }

  setSurface(i: number, s: SurfaceSample): void {
    const t = this.wheelSurface[i];
    t.grip = s.grip;
    t.rollingResist = s.rollingResist;
    t.waterDepth = s.waterDepth;
    t.bank = s.bank;
    t.slopeAlong = s.slopeAlong;
    t.slopeAcross = s.slopeAcross;
    t.rubber = s.rubber;
  }

  /** Place the car in the world. */
  place(x: number, y: number, heading: number, speed = 0): void {
    this.x = x;
    this.y = y;
    this.heading = heading;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    this.vx = c * speed;
    this.vy = s * speed;
    this.vxLocal = speed;
    this.vyLocal = 0;
    this.speed = speed;
    this.spinUp(speed);
  }

  /**
   * Match the wheel and engine speeds to a road speed.
   *
   * This is not a nicety. place() on its own leaves every tyre at omega = 0
   * while the body moves, and slipRatio = (omega*r - vx)/max(...) then reads
   * -1.0: four fully locked tyres. The combined-slip law spends the entire
   * friction budget on that longitudinal slip and hands the tyres almost no
   * lateral force, so a car placed at speed - the whole starting grid, every
   * pace car, every pit rejoin - spends its first moments with no grip at all.
   * The free-rolling fronts recover in a few steps, but the driven rears are
   * held down by engine braking torque and stay locked for half a second or
   * more, which is a rear axle at 0.09 g against 0.81 g at the front. On a
   * flat road that is survivable. On 31 degrees of banking, where the tyres
   * owe a constant 0.6 g sideways from the very first step, it is a spin, and
   * it is exactly what threw the pace car off the top of the turn.
   */
  spinUp(speed: number): void {
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const tyreSpec = front ? this.spec.tyreFront : this.spec.tyreRear;
      const pressure = front ? this.setup.tyrePressureFront : this.setup.tyrePressureRear;
      const radius = rollingRadius(tyreSpec, this.tyres[i], pressure);
      this.tyres[i].omega = speed / Math.max(0.05, radius);
    }
    // Mirror the drivetrain solve in stepVehicle so the first step's torque
    // lookup is not reading a stale crank speed.
    const ratio = Math.abs(this.gearRatio()) * this.setup.finalDrive;
    const drivenOmega = (this.tyres[2].omega + this.tyres[3].omega) / 2;
    const engineOmega = Math.abs(drivenOmega * ratio);
    const idleOmega = this.spec.engine.idleRpm * 2 * Math.PI / 60;
    this.rpm = clamp(Math.max(engineOmega, idleOmega) * 60 / (2 * Math.PI), 500,
      this.spec.engine.redlineRpm + 1200);
  }

  wheelPosition(i: number): { x: number; y: number } {
    const spec = this.spec;
    const a = this.cgFractionFront();
    const lf = spec.wheelbase * a;
    const lr = spec.wheelbase * (1 - a);
    if (i === FL) return { x: lf, y: spec.trackFront / 2 };
    if (i === FR) return { x: lf, y: -spec.trackFront / 2 };
    if (i === RL) return { x: -lr, y: spec.trackRear / 2 };
    return { x: -lr, y: -spec.trackRear / 2 };
  }

  /** Static ride height of an axle, m (includes fuel/ballast squat). */
  rideHeight(front: boolean): number {
    const setup = this.setup;
    const spec = this.spec;
    const base = (front ? setup.rideHeightFront : setup.rideHeightRear) / 1000;
    // Heavier cars sit lower; fuel load squats the car slightly.
    const load = (this.mass - spec.massKg) / 300;
    return clamp(base - load * 0.004, 0.012, spec.suspFront.travel * 0.9);
  }

  totalMass(): number {
    const spec = this.spec;
    const setup = this.setup;
    return spec.massKg + setup.ballastKg + this.fuelL * spec.fuel.density;
  }

  /** 0 = rear axle, 1 = front axle, for the current mass layout. */
  cgFractionFront(): number {
    const spec = this.spec;
    const setup = this.setup;
    const m0 = spec.massKg;
    const ballast = setup.ballastKg;
    const fuel = this.fuelL * spec.fuel.density;
    // Fuel tank sits just behind the CG on a mid-engined car, ahead on a GT.
    const fuelPos = spec.id === 'formula-pro' ? 0.48 : 0.42;
    return (m0 * spec.weightDistributionFront + ballast * setup.ballastPos + fuel * fuelPos) /
      Math.max(1, m0 + ballast + fuel);
  }

  gearCount(): number {
    return this.setup.gearRatios.length;
  }

  gearRatio(): number {
    const g = this.gear;
    if (g === 0) return 0;
    if (g < 0) return -this.spec.gearbox.reverseRatio;
    const ratios = this.setup.gearRatios;
    return ratios[clamp(g - 1, 0, ratios.length - 1)];
  }

  /** Engine torque curve, N m at the crank for a given rpm and throttle. */
  engineTorqueCurve(rpm: number, throttle: number): number {
    const e = this.spec.engine;
    const peak = e.peakTorque;
    const rp = e.peakRpm;
    let t: number;
    if (rpm < e.idleRpm) {
      t = peak * 0.55 * clamp(rpm / Math.max(1, e.idleRpm), 0.05, 1);
    } else if (rpm <= rp * 1.15) {
      t = peak;
    } else {
      const over = (rpm - rp * 1.15) / Math.max(1, e.redlineRpm - rp * 1.15);
      t = peak * clamp(1 - 0.55 * over, 0.35, 1);
    }
    return t * clamp(throttle, 0, 1);
  }
}

export interface StepContext {
  env: Environment;
  surfaces: SurfaceSample[]; // per wheel
  dt: number;
  /** Optional override for surface gravity component computation. */
  trackSlope?: { slopeX: number; slopeY: number };
}

const AIR = 1.225;

/**
 * Advance the vehicle by dt seconds. Fixed timestep recommended (<= 4 ms).
 * Returns nothing; the Vehicle instance is mutated.
 */
export function stepVehicle(
  car: Vehicle,
  input: CarInput,
  env: Environment,
  dt: number,
): void {
  const spec = car.spec;
  const setup = car.setup;
  const w = car.wheels;
  const tyres = car.tyres;

  // ---- Mass properties -------------------------------------------------
  const mass = car.totalMass();
  car.mass = mass;
  const aFrac = car.cgFractionFront();
  const lf = spec.wheelbase * aFrac;
  const lr = spec.wheelbase * (1 - aFrac);
  const weight = mass * G;
  const inertia = spec.inertiaYaw + mass * 0.03;

  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  // Body-frame velocity.
  // Rotate the world velocity into the body frame (x forward, y LEFT).
  car.vxLocal = car.vx * cosH + car.vy * sinH;
  car.vyLocal = -car.vx * sinH + car.vy * cosH;
  // Sanity: heading 0 must give vxLocal = vx and vyLocal = vy.
  const vx = car.vxLocal;
  const vy = car.vyLocal;
  const speed = Math.hypot(car.vx, car.vy);
  car.speed = speed;
  car.slipAngleBody = speed > 1 ? Math.atan2(vy, Math.abs(vx)) : 0;

  // ---- Geometry --------------------------------------------------------
  const tf = spec.trackFront;
  const tr = spec.trackRear;
  const positions = [
    { x: lf, y: tf / 2 }, { x: lf, y: -tf / 2 },
    { x: -lr, y: tr / 2 }, { x: -lr, y: -tr / 2 },
  ];
  for (let i = 0; i < 4; i++) {
    w[i].x = positions[i].x;
    w[i].y = positions[i].y;
    w[i].offTrack = car.wheelSurface[i].grip < 0.92;
    w[i].waterDepth = car.wheelSurface[i].waterDepth;
  }

  // ---- Ride heights, CG height ----------------------------------------
  const rhF = car.rideHeight(true);
  const rhR = car.rideHeight(false);
  const travelF = spec.suspFront.travel;
  const travelR = spec.suspRear.travel;

  // ---- Steering (first-order lag + rate limit) ----------------------
  // Speed-sensitive rack: the available lock falls off with speed, like a
  // real car. Without it, full lock at 25 m/s asks for 8 g and the model
  // draws an absurdly tight circle.
  const speedSensitiveLock = spec.steer.maxLock /
    (1 + speed / (spec.steer.speedSensitiveKmh / 3.6));
  const targetSteer = clamp(input.steer, -1, 1) * speedSensitiveLock;
  const rateLimit = spec.steer.maxRate * dt;
  const steerStep = clamp(
    (targetSteer - car.steeringAngle) * spec.steer.responseRate * dt,
    -rateLimit, rateLimit,
  );
  car.steeringAngle += steerStep;

  // ---- Aerodynamics ----------------------------------------------------
  const vRelX = car.vx - env.windX;
  const vRelY = car.vy - env.windY;
  const vRel = Math.hypot(vRelX, vRelY);
  const rho = env.airDensity || AIR;
  const yawDeg = (Math.atan2(vRelY, vRelX) - car.heading) / DEG;
  const absYaw = Math.abs(yawDeg);
  const k = rho / AIR;
  const v2 = (vRel * vRel) / (27.7778 * 27.7778); // normalised to 100 km/h

  // Ride-height-sensitive ground effect: lower = more downforce.
  const geF = (0.03 - rhF) * 1000 * spec.aero.groundEffectFrontPerMm;
  const geR = (0.042 - rhR) * 1000 * spec.aero.groundEffectRearPerMm;
  const wingF = setup.wingFront * spec.aero.wingLiftPerDegFront;
  const wingR = setup.wingRear * spec.aero.wingLiftPerDegRear;
  const stall = clamp(1 - spec.aero.downforceYawPerDeg * absYaw / 100, 0.2, 1);
  const dfFront = ((spec.aero.downforceFront100 + wingF) * v2 + geF * v2) * k * stall;
  const dfRear = ((spec.aero.downforceRear100 + wingR) * v2 + geR * v2) * k * stall;
  const downforce = Math.max(0, dfFront + dfRear);
  const drag = (spec.aero.drag100 + spec.aero.dragYawPerDeg * absYaw * 0.02 * v2 * 40) *
    v2 * k * car.dragMod;
  car.downforce = downforce;
  car.dragForce = drag;

  // ---- Roll / pitch geometry ------------------------------------------
  const kSpringF = spec.suspFront.springRate * setup.springFront;
  const kSpringR = spec.suspRear.springRate * setup.springRear;
  const kSpringRollF = kSpringF * tf * tf * 0.5;
  const kSpringRollR = kSpringR * tr * tr * 0.5;
  const kArbRollF = spec.suspFront.arbRate * setup.arbFront * 0.5;
  const kArbRollR = spec.suspRear.arbRate * setup.arbRear * 0.5;
  const kRollF = kSpringRollF + kArbRollF;
  const kRollR = kSpringRollR + kArbRollR;
  const kRoll = kRollF + kRollR;

  // Lateral acceleration estimate from the previous step (quasi-static).
  const ayEst = car.accelLat;
  const rollMoment = mass * ayEst * car.cgHeight -
    mass * G * (spec.suspFront.rollCentreHeight * 0.5 + spec.suspRear.rollCentreHeight * 0.5);
  const rollAngle = kRoll > 0 ? clamp(rollMoment / kRoll, -0.35, 0.35) : 0;
  const rollRate = (rollAngle - car.rollAngle) / dt;
  car.rollAngle = rollAngle;
  car.rollRate = clamp(rollRate, -6, 6);

  // Load transfer shares.
  const latTransferTotal = mass * ayEst * car.cgHeight / ((tf + tr) * 0.5);
  const latFront = latTransferTotal * (kRoll > 0 ? kRollF / kRoll : 0.5);
  const latRear = latTransferTotal - latFront;
  const longTransfer = mass * car.accelLong * car.cgHeight / spec.wheelbase;

  // Aerodynamic load per axle (already split front/rear by the aero model).
  const aeroFrontAxle = Math.max(0, dfFront);
  const aeroRearAxle = Math.max(0, dfRear);

  // ---- Per-wheel normal loads -----------------------------------------
  // Every term below is an AXLE load and must be halved to get the corner.
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const staticLoad = weight * (front ? aFrac : 1 - aFrac) * 0.5;
    const aeroLoad = (front ? aeroFrontAxle : aeroRearAxle) * 0.5;
    const longLoad = (front ? -longTransfer : longTransfer) * 0.5;
    // In a left turn (ay > 0) load transfers to the RIGHT (outside) wheel.
    const latLoad = (front ? latFront : latRear) * 0.5 * (left ? -1 : 1);
    w[i].fz = Math.max(0, staticLoad + aeroLoad + longLoad + latLoad);
  }

  // ---- Suspension travel & damping ------------------------------------
  let springForceTotal = 0;
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const travel = front ? travelF : travelR;
    const rh = front ? rhF : rhR;
    const susp = front ? spec.suspFront : spec.suspRear;
    const kCorner = (front ? kSpringF : kSpringR) * 0.5;
    const dampMul = front ? setup.damperFront : setup.damperRear;
    // Damper shaft speed: heave + pitch + roll contribution at this corner.
    const shaft = car.zVel + car.pitchRate * positions[i].x + car.rollRate * positions[i].y;
    const damp = (shaft >= 0 ? susp.bumpDamp : susp.reboundDamp) * dampMul * 0.5;
    const damperForce = -damp * shaft;
    // Static compression is the ride height itself; the corner then deflects
    // further as load is transferred onto it.
    const loadDeflection = clamp(w[i].fz / Math.max(1, kCorner) - rh, 0, travel);
    const compression = clamp(rh + loadDeflection * 0.35, 0, travel);
    const stopGap = susp.bumpStopGap;
    const pastStop = Math.max(0, compression - (travel - stopGap));
    const stopForce = susp.bumpStopRate * pastStop * 0.0002;
    springForceTotal += kCorner * compression + damperForce + stopForce;
    car.suspensionLoad[i] = compression;
  }

  // Sprung mass vertical dynamics (critically-ish damped heave).
  const zNet = springForceTotal - (weight + downforce);
  car.zVel = clamp(car.zVel + (zNet / mass) * dt * 2.4, -1.2, 1.2);
  car.zVel *= Math.exp(-4.5 * dt);
  car.zOff = clamp(car.zOff + car.zVel * dt, -0.04, 0.04);
  car.cgHeight = spec.cgHeight + car.zOff;

  // Pitch follows the longitudinal load transfer.
  const targetPitch = clamp(longTransfer * car.cgHeight / Math.max(1, kRoll * 0.25),
    -0.06, 0.06);
  car.pitchRate = clamp((targetPitch - car.pitchAngle) / dt * 0.06, -3, 3);
  car.pitchAngle += car.pitchRate * dt;

  // Camber: static setup + roll gradient (+ toe, which also steers the wheel).
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const camberStatic = (front ? setup.camberFront : 0) * DEG;
    const camberRoll = rollAngle * setup.camberRoll * DEG * (left ? 1 : -1);
    w[i].camber = camberStatic + camberRoll;
  }

  // ---- Brakes ----------------------------------------------------------
  const pedal = clamp(input.brake, 0, 1);
  const rate = pedal > car.brakePressure ? spec.brakes.buildRate : spec.brakes.releaseRate;
  car.brakePressure += clamp((pedal - car.brakePressure) * rate * dt, -1, 1);
  car.brakePressure = clamp(car.brakePressure, 0, 1);
  car.brakePedal = car.brakePressure;

  const ratioNow = car.gearRatio();
  const finalDriveNow = setup.finalDrive;

  // ---- Engine, clutch and gearbox ----------------------------------------
  // The engine is a rotating mass coupled to the driven wheels through a
  // torque-limited clutch. The clutch reaction is what loads the engine, so
  // the revs settle where the drivetrain and the throttle balance. Without
  // that feedback the wheels spin at huge slip ratios while the engine sits
  // at its torque peak, which cooks the tyres on a straight line.
  const eff = spec.gearbox.efficiency;
  const totalRatio = Math.abs(ratioNow) * finalDriveNow;
  const driveSign = Math.sign(ratioNow) || 1;

  if (car.shiftTimer > 0) car.shiftTimer = Math.max(0, car.shiftTimer - dt);
  const canShift = car.shiftTimer <= 0;
  if (input.shiftUp && canShift && car.gear >= 1 && car.gear < car.gearCount()) {
    car.gear += 1;
    car.shiftTimer = spec.engine.upshiftTime;
  } else if (input.shiftDown && canShift && car.gear > 0) {
    car.gear -= 1;
    car.shiftTimer = spec.engine.downshiftTime;
  }
  const shifting = car.shiftTimer > 0;
  const clutchPedal = clamp(input.clutch, 0, 1);
  const clutchCap = spec.engine.peakTorque * 1.25 * (1 - clutchPedal) * (shifting ? 0 : 1);

  // Throttle actuation lag + throttle map shaping.
  const map = setup.throttleMap;
  const shaped = Math.pow(clamp(input.throttle, 0, 1), 1 + (1 - map) * 1.1);
  car.throttleActual = clamp(
    car.throttleActual + (shaped - car.throttleActual) * spec.engine.responseRate * dt, 0, 1);

  // Engine braking: zero at idle (so the car does not creep), rising with rpm
  // once the throttle is shut.
  const idleRpm = spec.engine.idleRpm;
  const overIdle = clamp((car.rpm - idleRpm) /
    Math.max(1, spec.engine.redlineRpm - idleRpm), 0, 2);
  const engineBrake = spec.engine.engineBrakeTorque * setup.engineBrakeMap * overIdle *
    (1 - clamp(car.throttleActual, 0, 1));

  // An idle governor holds the revs at idle with the throttle shut; above that
  // the throttle controls torque directly.
  const governor = car.throttleActual < 0.03
    ? clamp((idleRpm - car.rpm) / 900, -1, 1) * spec.engine.peakTorque * 0.1
    : car.engineTorqueCurve(car.rpm, car.throttleActual);
  const torqueDemand = governor - engineBrake;

  // Traction control works by backing off the throttle, like a real system.
  let tcCut = 1;
  if (setup.tcLevel > 0) {
    // A real traction control still allows a couple of tenths of slip; asking
    // for less than that simply cuts the engine at every launch. Allow more
    // slip at low speed, the way a launch-control map does.
    const launchAllowance = clamp(1 - car.speed / 25, 0, 1) * 0.18;
    const slipLimit = 0.44 - setup.tcLevel * 0.18 + launchAllowance;
    // Wheelspin only: a wheel being dragged slower than the ground (negative
    // slip) is not spinning up, and cutting torque there locks the drivetrain
    // into a fight with itself.
    const maxSlip = Math.max(tyres[RL].relaxedSlipRatio, tyres[RR].relaxedSlipRatio);
    if (maxSlip > slipLimit) {
      tcCut = clamp(1 - (maxSlip - slipLimit) * (2.5 + setup.tcLevel * 18), 0, 1);
    }
  }


  const demand = torqueDemand > 0 ? torqueDemand * tcCut : torqueDemand;
  // Clutch model. The drivetrain is solved quasi-statically: the engine speed
  // is derived from the driven wheels plus a clutch-slip state, and that state
  // only grows while the engine has torque left over after the clutch has
  // taken its share. Solving the engine as a free-spinning mass instead makes
  // the coupling diverge, because nothing feeds the tyre grip limit back.
  let wheelOmegaAvg = 0;
  for (const i of [2, 3]) wheelOmegaAvg += car.tyres[i].omega;
  wheelOmegaAvg *= 0.5;
  const engaged = car.gear !== 0 && totalRatio > 1e-3 && !shifting;
  const drivenWheelOmega = engaged ? wheelOmegaAvg * driveSign : 0;
  const slipDecay = engaged ? 45 : 12;
  car.clutchSlip += (car.clutchSlip * -slipDecay) * dt;
  const slipCap = 40 + 700 * clamp(car.throttleActual, 0, 1);
  const excess = engaged ? (demand - clutchCap) : demand;
  if (excess > 0) {
    car.clutchSlip = clamp(car.clutchSlip + (excess / spec.engine.inertia) * dt, 0, slipCap);
  }
  car.clutchSlip = clamp(car.clutchSlip, 0, slipCap);

  // Engine speed follows the wheels through the gearbox, plus clutch slip.
  const engineOmega = Math.abs(drivenWheelOmega * totalRatio) + car.clutchSlip;
  const idleOmega = idleRpm * 2 * Math.PI / 60;
  car.rpm = clamp(Math.max(engineOmega, idleOmega) * 60 / (2 * Math.PI), 500,
    spec.engine.redlineRpm + 1200);

  // Torque the clutch actually transmits.
  const clutchTorque = clamp(demand, -clutchCap, clutchCap);
  car.wheelTorqueDrive = clutchTorque * totalRatio * eff * driveSign;
  car.engineTorque = clutchTorque;

  // ---- Per-wheel forces --------------------------------------------------
  const brakeBias = clamp(setup.brakeBias, 0, 1);
  const brakeFade = clamp(1 - spec.brakes.fadePer100C * Math.max(0, car.brakeTemp - 420) / 100,
    0.3, 1);
  const totalBrakeTorque = car.brakePressure * brakeFade *
    (spec.brakes.frontMax + spec.brakes.rearMax);
  const absActive = setup.absLevel > 0;
  const absSlipLimit = 0.42 - setup.absLevel * 0.26;

  let sumFx = 0;
  let sumFy = 0;
  let sumMz = 0;
  let slipWork = 0;
  let maxUtil = 0;
  let drivenSlip = 0;

  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const surface = car.wheelSurface[i];
    const tyreSpec = front ? spec.tyreFront : spec.tyreRear;
    const tyre = tyres[i];
    const pressure = front ? setup.tyrePressureFront : setup.tyrePressureRear;
    const radius = rollingRadius(tyreSpec, tyre, pressure);

    // Wheel longitudinal speed at the contact patch (body frame).
    const wheelVx = vx - car.yawRate * positions[i].y;
    const wheelVy = vy + car.yawRate * positions[i].x;
    const steerAngle = front ? car.steeringAngle : 0;
    const toe = (front ? setup.toeFront : setup.toeRear) * DEG * (left ? 1 : -1);
    const wheelHeading = steerAngle + toe;

    // Slip angle: angle between the wheel heading and the velocity at the patch.
    const speedAtPatch = Math.hypot(wheelVx, wheelVy);
    let slipAngle = 0;
    if (speedAtPatch > 0.4) {
      const velAngle = Math.atan2(wheelVy, wheelVx);
      slipAngle = wheelHeading - velAngle;
      if (slipAngle > Math.PI) slipAngle -= 2 * Math.PI;
      if (slipAngle < -Math.PI) slipAngle += 2 * Math.PI;
    }
    w[i].slipAngle = slipAngle;

    // Slip ratio from the wheel's rotational speed.
    const denom = Math.max(Math.abs(tyre.omega * radius), Math.abs(wheelVx),
      0.15 + 0.02 * Math.abs(wheelVx));
    const slipRatio = clamp((tyre.omega * radius - wheelVx) / denom, -1.5, 1.5);
    w[i].slipRatio = slipRatio;

    const forces = tyreForces(tyreSpec, tyre, {
      fz: w[i].fz,
      slipRatio,
      slipAngle,
      camber: w[i].camber,
      side: i % 2 === 0 ? 1 : -1,
      vx: Math.max(0.1, Math.abs(wheelVx)),
      waterDepth: surface.waterDepth,
      surfaceGrip: surface.grip * env.baseGrip * car.gripMod,
    }, {
      trackTempC: env.trackTempC,
      speed: Math.max(1, speed),
      pressureBar: pressure,
      dt,
    });
    w[i].mu = forces.mu;
    w[i].utilisation = forces.combinedSlip;
    maxUtil = Math.max(maxUtil, forces.combinedSlip);

    // ---- Braking torque on this wheel --------------------------------
    const axleShare = front ? brakeBias : 1 - brakeBias;
    const axleMax = front ? spec.brakes.frontMax : spec.brakes.rearMax;
    const handbrake = i >= 2 ? clamp(input.handbrake, 0, 1) : 0;
    // Total torque is split between the two wheels of the axle.
    let brakeTorque = totalBrakeTorque * axleShare * 0.5 +
      handbrake * spec.brakes.rearMax * 0.5;
    void axleMax;
    // ABS: a real modulator. Pressure is dumped quickly once the wheel passes
    // its slip target and pumped back up as soon as the wheel recovers.
    // Scaling the torque directly instead latches the brake at its floor, so
    // the car stops braking altogether and the stop takes twice as long.
    let locked = false;
    const effectiveSlip = tyre.relaxedSlipRatio;
    if (absActive && wheelVx > 1.5) {
      // Regulate slip around the target instead of dumping to the floor: a
      // modulator that only ever releases parks the brake at 4% and the stop
      // takes twice as long. The gain is fast enough to cycle a few tens of
      // times a second, which is what a real unit does.
      const err = absSlipLimit - Math.abs(effectiveSlip);
      const gain = 60 * (0.5 + setup.absLevel);
      car.absPressure[i] = clamp(car.absPressure[i] + err * gain * dt, 0.05, 1);
    } else {
      car.absPressure[i] = Math.min(1, car.absPressure[i] + 4 * dt);
    }
    brakeTorque *= car.absPressure[i];
    if (brakeTorque > 0 && Math.abs(effectiveSlip) > 0.9 && wheelVx > 1) {
      locked = true;
    }
    w[i].brakeTorque = brakeTorque;
    w[i].locked = locked;

    // ---- Drive torque (rear-wheel drive) ------------------------------
    let driveTorque = 0;
    if (i >= 2) {
      driveTorque = car.wheelTorqueDrive * 0.5;
      drivenSlip = Math.max(drivenSlip, Math.abs(slipRatio));
    }
    w[i].driveTorque = driveTorque;
    w[i].spin = i >= 2 && tyre.relaxedSlipRatio > 0.35 &&
      Math.abs(car.wheelTorqueDrive) > 20;

    // ---- Wheel rotational dynamics ------------------------------------
    const spinDir = Math.sign(tyre.omega) || Math.sign(wheelVx) || 1;
    const netTorque = driveTorque - brakeTorque * spinDir - forces.fx * radius;
    // The engine and clutch inertia, reflected through the gearbox, is several
    // times the wheel's own inertia. That is why a real car does not instantly
    // spin its wheels the moment you touch the throttle.
    const lockFraction = Math.exp(-Math.abs(car.clutchSlip) / 30);
    const reflected = i >= 2
      ? (spec.engine.inertia * 0.5 * totalRatio * totalRatio) * lockFraction
      : 0;
    const inertia = tyreSpec.inertia + reflected;
    const omegaBefore = tyre.omega;
    tyre.omega += (netTorque / inertia) * dt;

    // A brake can bring a wheel to a stop but can never spin it backwards.
    // Without this clamp the brake torque flips sign along with the wheel and
    // starts driving it, which turns a hard stop into acceleration.
    if (brakeTorque > 0 && omegaBefore >= 0 && tyre.omega < 0) {
      tyre.omega = 0;
      w[i].locked = true;
    }

    // Static friction: a wheel that is nearly stopped and has no drive torque
    // available stays stopped. Without this, rolling resistance alone spins
    // the wheel up and a parked car rolls away by itself.
    const breakawayTorque = w[i].fz * radius * Math.max(0.25, forces.mu * 0.95);
    const appliedTorque = driveTorque - brakeTorque * (Math.sign(tyre.omega) ||
      Math.sign(wheelVx) || 1);
    if (car.speed < 0.3 && Math.abs(wheelVx) < 0.4 &&
        Math.abs(appliedTorque) < breakawayTorque) {
      tyre.omega = wheelVx / Math.max(0.05, radius);
    }

    // Convert tyre frame forces into body frame.
    const cosS = Math.cos(wheelHeading);
    const sinS = Math.sin(wheelHeading);
    const fxBody = forces.fx * cosS - forces.fy * sinS;
    const fyBody = forces.fx * sinS + forces.fy * cosS;
    w[i].fx = fxBody;
    w[i].fy = fyBody;

    // Off-track surface drag (grass/gravel slows the car).
    const extraRoll = surface.rollingResist * Math.max(0, w[i].fz);
    const surfDragX = -extraRoll * Math.sign(wheelVx || 1);

    // Rolling resistance only exists once the wheel is actually rolling;
    // otherwise it pushes a parked car backwards.
    const rollScale = clamp(Math.abs(wheelVx) / 0.5, 0, 1);
    sumFx += fxBody + surfDragX -
      forces.rollingResist * Math.sign(wheelVx || 1) * rollScale;
    sumFy += fyBody;
    sumMz += positions[i].x * fyBody - positions[i].y * fxBody + forces.mz;
    slipWork += forces.slipEnergyRate;

    // Tyre thermal model.
    // Cyclic deformation of the carcass is the dominant heat source for a
    // tyre that is rolling: rolling resistance force times rolling speed.
    const hysteresis = forces.rollingResist * Math.abs(wheelVx);
    tyreThermalStep(tyreSpec, tyre, dt, forces.slipEnergyRate, w[i].fz,
      env.airTempC, speed, env.trackTempC, hysteresis);
    tyre.slipEnergy += forces.slipEnergyRate * dt;
    car.tyreTemps[i] = tyre.coreTemp;
    car.tyreWear[i] = tyre.wear;
    car.wheelSurface[i].grip = surface.grip;
  }

  car.wheelspin = drivenSlip;
  car.outOfGrip = maxUtil;

  // ---- Limited slip differential ----------------------------------------
  // Already applied implicitly through independent wheel torques; add the
  // preload torque that resists a speed difference between the driven wheels.
  if (spec.diff.preloadNm > 0 || setup.diffPreload > 0) {
    const preload = setup.diffPreload;
    const dOmega = tyres[RL].omega - tyres[RR].omega;
    // Ramp the preload in over the first half rad/s of speed difference.
    // Taking a hard sign() applies the full preload in an arbitrary direction
    // the instant the two wheels differ by a float, which amplifies any tiny
    // numerical asymmetry into a spin on a straight line.
    const dir = clamp(dOmega / 0.5, -1, 1);
    const resist = -dir * preload * (0.4 + setup.diffLock * 0.6);
    tyres[RL].omega += (resist / spec.tyreRear.inertia) * dt;
    tyres[RR].omega -= (resist / spec.tyreRear.inertia) * dt;
  }

  // ---- Gravity from track slope / banking -------------------------------
  let slopeAlong = 0;
  let slopeAcross = 0;
  for (let i = 0; i < 4; i++) {
    slopeAlong += car.wheelSurface[i].slopeAlong;
    slopeAcross += car.wheelSurface[i].slopeAcross;
  }
  slopeAlong /= 4;
  slopeAcross /= 4;
  // Project world gravity onto the body frame.
  // slopeAlong/slopeAcross are the grade in the car's own frame, so gravity
  // projects straight onto the body axes.
  const gravX = -mass * G * slopeAlong;
  const gravY = mass * G * slopeAcross;

  // ---- Aerodynamic drag in body frame -----------------------------------
  // Relative wind in the body frame.
  const windXLocal = env.windX * cosH + env.windY * sinH;
  const windYLocal = -env.windX * sinH + env.windY * cosH;
  const relXLocal = vx - windXLocal;
  const relYLocal = vy - windYLocal;
  const relLocal = Math.hypot(relXLocal, relYLocal);
  const dragX = relLocal > 0.01 ? -drag * relXLocal / relLocal : 0;
  const dragY = relLocal > 0.01 ? -drag * relYLocal / relLocal : 0;

  // ---- Integrate ----------------------------------------------------------
  const totalFx = sumFx + dragX + gravX;
  const totalFy = sumFy + dragY + gravY;
  const massAccel = mass * spec.massFactorAccel;
  car.accelLong = totalFx / massAccel;
  car.accelLat = totalFy / massAccel;

  // Integrate the velocity in the WORLD frame. Integrating in the body frame
  // and then re-projecting onto the updated heading would rotate the velocity
  // vector by the yaw increment for free, which is the same as handing the
  // car unlimited lateral grip: it would follow its nose like a kinematic
  // model and the tyres would never have to earn the corner.
  const fxWorld = totalFx * cosH - totalFy * sinH;
  const fyWorld = totalFx * sinH + totalFy * cosH;
  car.vx += (fxWorld / massAccel) * dt;
  car.vy += (fyWorld / massAccel) * dt;

  car.yawRate += (sumMz / inertia) * dt;
  car.yawRate *= Math.exp(-0.35 * dt);
  car.heading += car.yawRate * dt;
  if (car.heading > Math.PI) car.heading -= 2 * Math.PI;
  if (car.heading < -Math.PI) car.heading += 2 * Math.PI;

  const c2 = Math.cos(car.heading);
  const s2 = Math.sin(car.heading);
  car.vxLocal = car.vx * c2 + car.vy * s2;
  car.vyLocal = -car.vx * s2 + car.vy * c2;
  const dx = car.vx * dt;
  const dy = car.vy * dt;
  car.x += dx;
  car.y += dy;
  car.distance += Math.hypot(dx, dy);

  // Static hold: a car that is essentially stopped with the throttle shut
  // must stay stopped. Without this, idle creep and a whisker of yaw drift
  // let the relaxation states wind up and the car wanders off the grid.
  if (car.speed < 0.4 && Math.abs(input.throttle) < 0.02 && car.brakePressure < 0.05) {
    const damp = Math.exp(-25 * dt);
    car.vx *= damp;
    car.vy *= damp;
    car.vxLocal *= damp;
    car.vyLocal *= damp;
    car.yawRate *= Math.exp(-40 * dt);
    for (const t of tyres) t.omega *= damp;
  }

  // ---- Brake & engine thermal ---------------------------------------------
  const brakePower = totalBrakeTorque * Math.abs(car.rpm) / 9549;
  car.brakeTemp += (brakePower * 0.02 - (car.brakeTemp - env.airTempC) * (0.02 + speed * 0.004)) * dt;
  car.brakeTemp = clamp(car.brakeTemp, env.airTempC, 1200);
  const enginePower = Math.max(0, car.engineTorque) * car.rpm / 9549;
  car.engineTemp += (enginePower * 0.02 - (car.engineTemp - env.airTempC) * 0.05) * dt;
  car.engineTemp = clamp(car.engineTemp, env.airTempC, 200);

  // Fuel burn.
  car.fuelL = clamp(car.fuelL - enginePower * spec.fuel.burnRate * dt, 0, spec.fuel.capacityL);

  // Steering feedback torque (for force feedback / wheel feel display).
  car.steeringTorque = (w[FL].fy + w[FR].fy) * 0.02 * spec.steer.feedbackGain +
    car.steeringAngle * 12;
}

/** Kinematic speed in km/h. */
export const kmh = (car: Vehicle): number => car.speed * 3.6;

/** Slip angle of the car body in degrees. */
export const bodySlipDeg = (car: Vehicle): number => car.slipAngleBody / DEG;

/** Overall tyre wear, 0..1. */
export function avgWear(car: Vehicle): number {
  return (car.tyreWear[0] + car.tyreWear[1] + car.tyreWear[2] + car.tyreWear[3]) / 4;
}

/** Average tyre temperature across all four corners, degC. */
export function avgTyreTemp(car: Vehicle): number {
  return (car.tyreTemps[0] + car.tyreTemps[1] + car.tyreTemps[2] + car.tyreTemps[3]) / 4;
}
