import { CarSpec, SuspSpec } from './types.js';
import { TyreSpec } from './tire.js';

/** Everything the player can change in the setup screen. */
export interface CarSetup {
  /** bar, hot target pressure per axle. */
  tyrePressureFront: number;
  tyrePressureRear: number;
  /** Static camber, deg (negative = top of tyre leans in). */
  camberFront: number;
  camberRoll: number;
  toeFront: number;
  toeRear: number;
  /** mm of static ground clearance per axle. */
  rideHeightFront: number;
  rideHeightRear: number;
  /** Spring/damper/ARB multipliers. */
  springFront: number;
  springRear: number;
  damperFront: number;
  damperRear: number;
  arbFront: number;
  arbRear: number;
  /** 0..1, fraction of total brake torque at the front. */
  brakeBias: number;
  /** 0..1, how locked the diff is on drive. */
  diffLock: number;
  diffPreload: number; // N m
  /** Gearbox. Index 0 = 1st gear. */
  gearRatios: number[];
  finalDrive: number;
  /** kg of ballast and its fore/aft position (0 = rear axle). */
  ballastKg: number;
  ballastPos: number;
  /** Wing angles, deg. */
  wingFront: number;
  wingRear: number;
  /** litres at session start. */
  fuelLoadL: number;
  /** Driver aids, 0..1 (0 = off). */
  tcLevel: number;
  absLevel: number;
  /** Throttle shaping map aggression, 0..1. */
  throttleMap: number;
  /** Engine braking (engine map), 0..1. */
  engineBrakeMap: number;
}

export interface Environment {
  trackTempC: number;
  airTempC: number;
  airDensity: number;
  /** Rainfall rate, mm/h (0 = dry). */
  rainMmH: number;
  /** Global grip multiplier for the surface material. */
  baseGrip: number;
  /** Crosswind, m/s along world +x. */
  windX: number;
  windY: number;
}

export const defaultEnvironment: Environment = {
  trackTempC: 32,
  airTempC: 22,
  airDensity: 1.225,
  rainMmH: 0,
  baseGrip: 1,
  windX: 0,
  windY: 0,
};

const susp = (
  springRate: number, bump: number, rebound: number, arb: number,
  travel: number, bumpStopGap: number, rollCentre: number,
): SuspSpec => ({
  springRate,
  bumpDamp: bump,
  reboundDamp: rebound,
  arbRate: arb,
  travel,
  bumpStopRate: 220000,
  bumpStopGap,
  rollCentreHeight: rollCentre,
});

const tyre = (
  name: 'formula' | 'gt3' | 'stock',
  isFront: boolean,
): TyreSpec => {
  const base = {
    pressureOpt: name === 'stock' ? 1.55 : 1.35,
    pressureK: 0.075,
    tempOpt: name === 'stock' ? 85 : 92,
    tempBand: name === 'stock' ? 34 : 30,
    tempDrop: 0.5,
    heatGain: name === 'formula' ? 4.0 : 3.7,
    coolCore: 0.05,
    coolAmbient: 0.005,
    wearRate: name === 'stock' ? 0.000045 : 0.00006,
    hydroSpeed: 22,
    rollingResist: name === 'formula' ? 0.011 : 0.014,
    relaxationLength: isFront ? 0.26 : 0.32,
    width: name === 'formula' ? (isFront ? 0.26 : 0.33) : 0.28,
    shapeB: 1.35,
    shapeC: 1.6,
    stiffLoadExp: 0.85,
  };
  if (name === 'formula') {
    return {
      ...base,
      muPeak: 1.62,
      loadSensitivity: 0.93,
      refLoad: 2200,
      corneringStiffness: 118000,
      longStiffness: 96000,
      camberThrust: 210,
      inertia: isFront ? 1.35 : 1.7,
      radius: 0.33,
    };
  }
  if (name === 'gt3') {
    return {
      ...base,
      muPeak: 1.45,
      loadSensitivity: 0.9,
      refLoad: 3000,
      corneringStiffness: 92000,
      longStiffness: 76000,
      camberThrust: 180,
      inertia: isFront ? 1.75 : 1.95,
      radius: 0.33,
    };
  }
  return {
    ...base,
    muPeak: 1.28,
    loadSensitivity: 0.88,
    refLoad: 3600,
    corneringStiffness: 78000,
    longStiffness: 62000,
    camberThrust: 140,
    inertia: isFront ? 2.3 : 2.6,
    radius: 0.355,
  };
};

/** Open-wheel, high downforce, mid-engine. Punishing but fast. */
export const FORMULA_PRO: CarSpec = {
  id: 'formula-pro',
  name: 'Formula Pro FX-9',
  short: 'FX-9',
  class: 'Formula',
  bodyColor: '#e23b3b',
  accentColor: '#f5f5f5',
  massKg: 620,
  weightDistributionFront: 0.455,
  inertiaYaw: 620,
  cgHeight: 0.3,
  wheelbase: 3.0,
  trackFront: 1.62,
  trackRear: 1.55,
  halfLength: 2.4,
  halfWidth: 0.92,
  massFactorAccel: 1.06,
  unsprungMass: 16,
  tyreFront: tyre('formula', true),
  tyreRear: tyre('formula', false),
  aero: {
    downforceFront100: 1300,
    downforceRear100: 2100,
    // CdA ~1.9: open-wheeler wings and exposed tyres.
    drag100: 896,
    dragYawPerDeg: 14,
    downforceYawPerDeg: 22,
    groundEffectFrontPerMm: 5.5,
    groundEffectRearPerMm: 9.5,
    wingLiftPerDegFront: 26,
    wingLiftPerDegRear: 46,
  },
  suspFront: susp(92000, 2600, 3600, 34000, 0.075, 0.014, 0.05),
  suspRear: susp(118000, 2800, 3800, 28000, 0.08, 0.014, 0.08),
  engine: {
    peakTorque: 560,
    peakRpm: 10500,
    idleRpm: 4200,
    redlineRpm: 13000,
    engineBrakeTorque: 78,
    inertia: 0.055,
    responseRate: 22,
    upshiftTime: 0.028,
    downshiftTime: 0.05,
  },
  gearbox: {
    gears: [3.05, 2.42, 2.0, 1.72, 1.5, 1.32, 1.16],
    finalDrive: 3.6,
    efficiency: 0.965,
    reverseRatio: 3.2,
  },
  diff: { lockRatio: 0.55, torqueBiasCap: 0.75, preloadNm: 45 },
  brakes: {
    frontMax: 4200,
    rearMax: 2600,
    buildRate: 12,
    releaseRate: 18,
    fadePer100C: 0.12,
    discMass: 4.2,
  },
  steer: {
    maxLock: 0.30,
    speedSensitiveKmh: 240,
    maxRate: 3.6,
    responseRate: 26,
    feedbackGain: 1,
  },
  fuel: { capacityL: 105, density: 0.75, burnRate: 0.000052 },
};

/** Front-engine GT3: heavier, more forgiving, strong mechanical grip. */
export const GT3_VENOM: CarSpec = {
  id: 'gt3-venom',
  name: 'Venom GT3-R',
  short: 'GT3-R',
  class: 'GT3',
  bodyColor: '#2f7de1',
  accentColor: '#f2c14e',
  massKg: 1245,
  weightDistributionFront: 0.48,
  inertiaYaw: 2450,
  cgHeight: 0.42,
  wheelbase: 2.68,
  trackFront: 1.66,
  trackRear: 1.63,
  halfLength: 2.3,
  halfWidth: 1.0,
  massFactorAccel: 1.05,
  unsprungMass: 22,
  tyreFront: tyre('gt3', true),
  tyreRear: tyre('gt3', false),
  aero: {
    downforceFront100: 420,
    downforceRear100: 780,
    // CdA ~1.10 for a GT3.
    drag100: 519,
    dragYawPerDeg: 16,
    downforceYawPerDeg: 18,
    groundEffectFrontPerMm: 2.2,
    groundEffectRearPerMm: 3.4,
    wingLiftPerDegFront: 14,
    wingLiftPerDegRear: 30,
  },
  suspFront: susp(112000, 3600, 4600, 42000, 0.09, 0.018, 0.07),
  suspRear: susp(124000, 3800, 4900, 34000, 0.095, 0.018, 0.09),
  engine: {
    peakTorque: 640,
    peakRpm: 7200,
    idleRpm: 1400,
    redlineRpm: 9000,
    engineBrakeTorque: 150,
    inertia: 0.14,
    responseRate: 16,
    upshiftTime: 0.045,
    downshiftTime: 0.075,
  },
  gearbox: {
    gears: [3.2, 2.35, 1.85, 1.52, 1.28, 1.1],
    finalDrive: 3.9,
    efficiency: 0.95,
    reverseRatio: 3.1,
  },
  diff: { lockRatio: 0.45, torqueBiasCap: 0.7, preloadNm: 70 },
  brakes: {
    frontMax: 6200,
    rearMax: 3400,
    buildRate: 10,
    releaseRate: 14,
    fadePer100C: 0.1,
    discMass: 6.5,
  },
  steer: { maxLock: 0.34, speedSensitiveKmh: 300, maxRate: 3.0, responseRate: 20, feedbackGain: 1 },
  fuel: { capacityL: 120, density: 0.75, burnRate: 0.000058 },
};

/** Front-heavy oval stock car: loose, slides a lot, needs a soft touch. */
export const STOCK_CHARGER: CarSpec = {
  id: 'stock-charger',
  name: 'Charger 500 Stock',
  short: 'STK-500',
  class: 'Stock',
  bodyColor: '#f2c14e',
  accentColor: '#20242b',
  massKg: 1520,
  weightDistributionFront: 0.55,
  inertiaYaw: 3100,
  cgHeight: 0.5,
  wheelbase: 2.85,
  trackFront: 1.6,
  trackRear: 1.6,
  halfLength: 2.55,
  halfWidth: 1.02,
  massFactorAccel: 1.05,
  unsprungMass: 26,
  tyreFront: tyre('stock', true),
  tyreRear: tyre('stock', false),
  aero: {
    downforceFront100: 260,
    downforceRear100: 420,
    // CdA ~1.35: a blunt stock car body.
    drag100: 637,
    dragYawPerDeg: 20,
    downforceYawPerDeg: 16,
    groundEffectFrontPerMm: 1.4,
    groundEffectRearPerMm: 2.0,
    wingLiftPerDegFront: 8,
    wingLiftPerDegRear: 18,
  },
  suspFront: susp(92000, 4200, 5200, 36000, 0.11, 0.02, 0.09),
  suspRear: susp(78000, 4000, 5000, 20000, 0.115, 0.02, 0.11),
  engine: {
    peakTorque: 780,
    peakRpm: 6800,
    idleRpm: 1200,
    redlineRpm: 8500,
    engineBrakeTorque: 190,
    inertia: 0.2,
    responseRate: 12,
    upshiftTime: 0.06,
    downshiftTime: 0.1,
  },
  gearbox: {
    gears: [2.9, 2.1, 1.65, 1.35, 1.15],
    finalDrive: 4.1,
    efficiency: 0.93,
    reverseRatio: 2.8,
  },
  diff: { lockRatio: 0.6, torqueBiasCap: 0.8, preloadNm: 90 },
  brakes: {
    frontMax: 5400,
    rearMax: 2400,
    buildRate: 8,
    releaseRate: 11,
    fadePer100C: 0.14,
    discMass: 8.5,
  },
  steer: { maxLock: 0.32, speedSensitiveKmh: 260, maxRate: 2.6, responseRate: 16, feedbackGain: 1 },
  fuel: { capacityL: 68, density: 0.75, burnRate: 0.000062 },
};

export const CAR_SPECS: Record<string, CarSpec> = {
  [FORMULA_PRO.id]: FORMULA_PRO,
  [GT3_VENOM.id]: GT3_VENOM,
  [STOCK_CHARGER.id]: STOCK_CHARGER,
};

export function defaultSetup(spec: CarSpec): CarSetup {
  return {
    tyrePressureFront: spec.tyreFront.pressureOpt,
    tyrePressureRear: spec.tyreRear.pressureOpt,
    camberFront: -3.2,
    camberRoll: -2.2,
    toeFront: 0.1,
    toeRear: -0.05,
    rideHeightFront: 30,
    rideHeightRear: 42,
    springFront: 1,
    springRear: 1,
    damperFront: 1,
    damperRear: 1,
    arbFront: 1,
    arbRear: 1,
    brakeBias: 0.55,
    diffLock: spec.diff.lockRatio,
    diffPreload: spec.diff.preloadNm,
    gearRatios: [...spec.gearbox.gears],
    finalDrive: spec.gearbox.finalDrive,
    ballastKg: 0,
    ballastPos: 0.4,
    wingFront: 12,
    wingRear: 18,
    fuelLoadL: spec.fuel.capacityL * 0.5,
    tcLevel: 0.4,
    absLevel: 0.45,
    throttleMap: 0.6,
    engineBrakeMap: 0.5,
  };
}

/** Effective rolling mass including fuel, ballast and rotating parts. */
export function effectiveMass(spec: CarSpec, setup: CarSetup, fuelL: number): number {
  return spec.massKg + setup.ballastKg + fuelL * spec.fuel.density;
}
