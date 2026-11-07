import { TyreSpec } from './tire.js';

/** Per-car constants that the player cannot change between sessions. */
export interface CarSpec {
  id: string;
  name: string;
  short: string;
  class: string;
  bodyColor: string;
  accentColor: string;
  /** kg, without ballast and without fuel. */
  massKg: number;
  /** 0 = at the rear axle, 1 = at the front axle. */
  weightDistributionFront: number;
  /** Rotational inertia about the vertical axis, kg m^2. */
  inertiaYaw: number;
  /** Height of the sprung-mass CG above ground at reference ride height, m. */
  cgHeight: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  /** Half lengths for collision, m. */
  halfLength: number;
  halfWidth: number;
  /** Rolling+rotating mass equivalent, multiplies longitudinal inertia. */
  massFactorAccel: number;
  /** kg of unsprung mass per corner. */
  unsprungMass: number;
  tyreFront: TyreSpec;
  tyreRear: TyreSpec;
  aero: {
    /** N at 100 km/h at zero yaw. */
    downforceFront100: number;
    downforceRear100: number;
    /** N at 100 km/h. */
    drag100: number;
    /** Extra drag per degree of yaw angle (drag rises hard when sideways). */
    dragYawPerDeg: number;
    /** Downforce lost per degree of yaw (stall). */
    downforceYawPerDeg: number;
    /** kg per 10mm of ride height change, front/rear. */
    groundEffectFrontPerMm: number;
    groundEffectRearPerMm: number;
    /** N at 100 km/h per degree of wing angle. */
    wingLiftPerDegFront: number;
    wingLiftPerDegRear: number;
  };
  suspFront: SuspSpec;
  suspRear: SuspSpec;
  engine: {
    /** N m at the crank at the peak. */
    peakTorque: number;
    /** rpm where peak torque occurs; flat plateau is +-15% of it. */
    peakRpm: number;
    idleRpm: number;
    redlineRpm: number;
    /** N m of internal friction/engine braking at redline, scales with rpm. */
    engineBrakeTorque: number;
    /** Engine+clutch+flywheel inertia, kg m^2. */
    inertia: number;
    /** 1/s, how fast the engine responds to throttle. */
    responseRate: number;
    upshiftTime: number;
    downshiftTime: number;
  };
  gearbox: {
    /** Wheel torque = engineTorque * gear * finalDrive * efficiency. */
    gears: number[];
    finalDrive: number;
    efficiency: number;
    reverseRatio: number;
  };
  diff: {
    /** 0 = fully open, 1 = fully locked. Applied on drive torque. */
    lockRatio: number;
    /** 0..1, how much torque can be sent to the gripping wheel. */
    torqueBiasCap: number;
    preloadNm: number;
  };
  brakes: {
    /** N m of braking torque per unit pedal at the front / rear axle. */
    frontMax: number;
    rearMax: number;
    /** How quickly brake pressure builds and releases, 1/s. */
    buildRate: number;
    releaseRate: number;
    /** Brake fade: torque lost per 100degC above the working temp. */
    fadePer100C: number;
    /** Disc mass, kg (for thermal model). */
    discMass: number;
  };
  steer: {
    /** rad of front wheel angle per unit of steering input, at standstill. */
    maxLock: number;
    /** km/h at which the available lock has halved (speed-sensitive rack). */
    speedSensitiveKmh: number;
    /** Steering rack speed limit, rad/s of road wheel. */
    maxRate: number;
    /** 1/s first-order steering response. */
    responseRate: number;
    /** Self-aligning torque feedback gain for wheel feel. */
    feedbackGain: number;
  };
  fuel: {
    capacityL: number;
    /** kg per litre. */
    density: number;
    /** Litres burnt per kW of engine output per second (~75 l/h at 400 kW). */
    burnRate: number;
  };
  /** Available gear count comes from gearbox.gears.length. */
  defaultGearRatios?: number[];
}

export interface SuspSpec {
  /** N/m per corner (spring + ARB share). */
  springRate: number;
  /** Bump and rebound damping, N/(m/s) per corner. */
  bumpDamp: number;
  reboundDamp: number;
  /** Roll stiffness of the anti-roll bar, N m/rad of roll. */
  arbRate: number;
  /** Total available droop travel, m (static ride height is part of it). */
  travel: number;
  /** Progressive bump stop, N per m beyond the stop gap. */
  bumpStopRate: number;
  bumpStopGap: number;
  /** Roll centre height above ground, m. */
  rollCentreHeight: number;
}
