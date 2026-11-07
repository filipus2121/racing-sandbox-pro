import { clamp, exp } from '../core/math.js';

/**
 * Pacejka-style combined slip tyre model ("Magic Formula" shape, simplified
 * combined-slip coupling). Everything the driver can feel comes out of here:
 * peak grip, the shape of the breakaway, load sensitivity, pressure and
 * temperature sensitivity, wear and hydroplaning.
 */

export interface TyreSpec {
  /** Peak dry friction coefficient at reference pressure/temperature/wear. */
  muPeak: number;
  /** <1 => grip falls off as load rises (real tyres do, ~0.85-0.95). */
  loadSensitivity: number;
  /** N of load where muPeak is quoted. */
  refLoad: number;
  /** Cornering stiffness per radian of slip angle, N/rad at refLoad. */
  corneringStiffness: number;
  /** Longitudinal stiffness per unit slip ratio, N at refLoad. */
  longStiffness: number;
  /** Shape factor of the lateral magic formula (>1 => progressive peak). */
  shapeB: number;
  /** Curvature factor. */
  shapeC: number;
  /** Load sensitivity of the stiffness itself. */
  stiffLoadExp: number;
  /** Camber thrust: N of lateral force per degree of camber at refLoad. */
  camberThrust: number;
  /** Pressure sensitivity, relative per bar away from optimal. */
  pressureOpt: number;
  pressureK: number;
  /** Temperature window (degC). */
  tempOpt: number;
  tempBand: number;
  tempDrop: number;
  /** Tread heating rate: degC per second for each kW dumped into the tyre. */
  heatGain: number;
  /** Surface->core and core->ambient transfer rates, 1/s. */
  coolCore: number;
  coolAmbient: number;
  /** Wear accumulation per kW of slip power, per kN of load. */
  wearRate: number;
  /** Speed at which a fully flooded tyre starts to plane, m/s. */
  hydroSpeed: number;
  /** Rolling resistance coefficient. */
  rollingResist: number;
  /** Tyre relaxation length, m. The carcass takes this long (in distance
   *  travelled) to build up to a new slip angle - without it the lateral
   *  force reacts instantly and the model shimmies at racing speeds. */
  relaxationLength: number;
  /** Unsprung+wheel inertia, kg m^2 (overwritten by wheelsInertia if set). */
  inertia: number;
  radius: number;
  width: number; // m, contact patch width, used for hydroplaning
}

export interface TyreState {
  /** Bulk carcass temperature, degC. */
  coreTemp: number;
  /** Tread surface temperature, degC. */
  surfaceTemp: number;
  /** 0 = new, 1 = dead. */
  wear: number;
  /** Rotational speed, rad/s. */
  omega: number;
  /** Accumulated slip energy, J (telemetry). */
  slipEnergy: number;
  /** Relaxation states: the slip the carcass has actually built up. */
  relaxedSlipAngle: number;
  relaxedSlipRatio: number;
}

export interface TyreLoad {
  /** Normal load, N. */
  fz: number;
  /** Longitudinal slip ratio (0 = rolling, 1 = locked/spinning). */
  slipRatio: number;
  /** Tyre slip angle, rad (positive = velocity points left of heading). */
  slipAngle: number;
  /** Effective camber, rad (positive = top of tyre leans out). */
  camber: number;
  /** +1 for a left-hand wheel, -1 for a right-hand one. Camber thrust is
   *  mirrored by this, so the two wheels of an axle cancel on a straight.
   *  Optional: standalone tyre probes default to a left-hand wheel. */
  side?: number;
  /** Surface longitudinal speed under the contact patch, m/s. */
  vx: number;
  /** Water film depth on the surface, mm. */
  waterDepth: number;
  /** Local track grip multiplier (rubbered-in line, marbles). */
  surfaceGrip: number;
}

export interface TyreForces {
  fx: number;
  fy: number;
  /** Aligning/self-aligning moment, N m (for force feedback + steering weight). */
  mz: number;
  mu: number;
  peakLat: number;
  peakLong: number;
  slipEnergyRate: number; // W
  combinedSlip: number; // 0..1+ how close to the friction limit
  rollingResist: number; // N
}

export function tyreMu(spec: TyreSpec, st: TyreState, fz: number, env: {
  trackTempC: number;
  waterDepth: number;
  speed: number;
  surfaceGrip: number;
  pressureBar: number;
}): number {
  // Load sensitivity: more load => slightly less grip per newton.
  const loadFactor = fz > 0 ? Math.pow(spec.refLoad / fz, 1 - spec.loadSensitivity) : 1;

  // Pressure: a soft quadratic penalty away from the optimal hot pressure.
  const dp = env.pressureBar - spec.pressureOpt;
  const pressureFactor = clamp(1 - spec.pressureK * dp * dp, 0.55, 1.03);

  // Temperature window: sharp drop-off outside the working band.
  const dT = st.coreTemp - spec.tempOpt;
  const tempFactor = clamp(
    1 - spec.tempDrop * (dT * dT) / (spec.tempBand * spec.tempBand),
    0.35,
    1,
  );

  // Wear: grip fades, then falls off a cliff near the end of life.
  const wearFactor = clamp(1 - 0.55 * st.wear - 0.35 * Math.pow(st.wear, 6), 0.25, 1);

  // Hydroplaning: grip is destroyed once the film can no longer be displaced.
  const flood = clamp(env.waterDepth / 2.5, 0, 1);
  const planeOnset = clamp(env.speed / Math.max(1, spec.hydroSpeed), 0, 1.6);
  const waterFactor = clamp(1 - flood * (0.25 + 0.75 * planeOnset * planeOnset), 0.08, 1);

  return (
    spec.muPeak * loadFactor * pressureFactor * tempFactor * wearFactor *
    waterFactor * env.surfaceGrip
  );
}

export function tyreForces(
  spec: TyreSpec,
  st: TyreState,
  load: TyreLoad,
  env: { trackTempC: number; speed: number; pressureBar: number; dt?: number },
): TyreForces {
  const fz = Math.max(0, load.fz);
  // Relaxation: the carcass lags the demanded slip by roughly the
  // relaxation length of travel. This is real tyre behaviour and it is also
  // what keeps the solver stable.
  const dt = env.dt ?? 0.002;
  const travel = Math.max(0.15, load.vx) * dt;
  const alpha = 1 - Math.exp(-travel / Math.max(0.05, spec.relaxationLength));
  st.relaxedSlipAngle += (load.slipAngle - st.relaxedSlipAngle) * alpha;
  st.relaxedSlipRatio += (load.slipRatio - st.relaxedSlipRatio) * alpha;
  const speed = Math.max(0.01, env.speed);
  const mu = tyreMu(spec, st, fz, {
    trackTempC: env.trackTempC,
    waterDepth: load.waterDepth,
    speed,
    surfaceGrip: load.surfaceGrip,
    pressureBar: env.pressureBar,
  });

  const loadRatio = fz > 0 ? fz / spec.refLoad : 0;
  // Stiffness scales sub-linearly with load, mirroring how the peak does.
  const stiffScale = Math.pow(loadRatio, spec.stiffLoadExp);
  const cy = spec.corneringStiffness * stiffScale;
  const cx = spec.longStiffness * stiffScale;

  const peakLat = mu * fz;
  const peakLong = mu * fz;
  if (peakLat <= 0) {
    return {
      fx: 0, fy: 0, mz: 0, mu, peakLat: 0, peakLong: 0,
      slipEnergyRate: 0, combinedSlip: 0,
      rollingResist: spec.rollingResist * fz,
    };
  }

  // The carcass acts on the slip it has actually built up, not the instant
  // demanded value (see the relaxation step above).
  const slipAngle = st.relaxedSlipAngle;
  const slipRatio = st.relaxedSlipRatio;
  const By = cy / Math.max(1, peakLat);
  const Bx = cx / Math.max(1, peakLong);

  // --- Combined-slip magic formula -------------------------------------
  // Both axes share one friction budget. sigma is the combined slip; the
  // total force magnitude follows a single magic-formula curve in sigma and
  // is then split between the axes in proportion to their own slip. That
  // gives a genuine peak with a real fall-away beyond it, and it makes
  // braking/driving properly eat into the cornering grip.
  const sx = Math.abs(slipRatio);
  const sy = Math.tan(clamp(Math.abs(slipAngle), 0, 1.2));
  const sigma = Math.hypot(Bx * sx, By * sy);
  const camberThrust = spec.camberThrust * (load.camber * 180 / Math.PI) * loadRatio;
  const peakArg = Math.PI / (2 * spec.shapeC);

  let outFx = 0;
  // Camber thrust pushes the wheel toward the direction it leans. Taking the
  // sign of the camber instead of the side of the car gives both wheels the
  // same direction, so they add up and the car steers itself off line.
  let outFy = camberThrust * (load.side || 1);
  let combinedSlip = 0;
  if (sigma > 1e-6 && fz > 0) {
    const argS = Math.min(sigma, peakArg);
    const beyond = Math.max(0, sigma - peakArg);
    // Past the peak the tyre settles onto its sliding friction, which for a
    // racing slick is still about 78% of the peak. Letting the force decay to
    // zero here is the classic bug that makes a locked wheel stop braking and
    // a spinning wheel stop driving.
    const decay = 0.78 + 0.22 * Math.exp(-beyond * 1.6);
    const fMag = peakLat * Math.sin(spec.shapeC * Math.atan(argS)) * decay;
    outFx += fMag * ((Bx * sx) / sigma) * Math.sign(slipRatio || 1);
    outFy += fMag * ((By * sy) / sigma) * Math.sign(slipAngle || 1);
    combinedSlip = sigma / peakArg;
  }
  // Self aligning moment: pneumatic trail shrinks with slip angle.
  const trail = 0.12 * spec.width * clamp(1 - 2.2 * Math.abs(load.slipAngle), 0.12, 1);
  const mz = -outFy * trail;

  // Energy dumped into the tread as heat and rubber.
  const slipVelLong = slipRatio * load.vx;
  const slipVelLat = Math.tan(clamp(slipAngle, -1.2, 1.2)) * load.vx;
  // Only true sliding heats the tread; rolling resistance is hysteresis loss.
  const slipEnergyRate = Math.abs(outFx * slipVelLong) + Math.abs(outFy * slipVelLat);

  return {
    fx: outFx,
    fy: outFy,
    mz,
    mu,
    peakLat,
    peakLong,
    slipEnergyRate,
    combinedSlip,
    rollingResist: spec.rollingResist * fz,
  };
}

/** Exponential helper re-exported for readability at call sites. */
export { exp };

/** One thermal + wear integration step for a single tyre. */
export function tyreThermalStep(
  spec: TyreSpec,
  st: TyreState,
  dt: number,
  slipPowerW: number,
  loadN: number,
  ambientC: number,
  speed: number,
  trackTempC = ambientC,
  hysteresisW = 0,
): void {
  // Slip work is only part of the story: a rolling tyre also heats through
  // hysteresis in the carcass, which is what brings it up to temperature on
  // a straight line where there is almost no slip at all.
  const kw = (slipPowerW + hysteresisW) / 1000;
  // The tread sits between two baths: the air flowing over it and the tarmac
  // it is pressed against. Convection grows with speed, which is why tyres
  // run cooler on a fast, low-slip lap than in a slow, sliding one.
  const bath = 0.4 * ambientC + 0.6 * trackTempC;
  // All three terms are degC/s. Convection grows with speed, so a tyre runs
  // cooler on a fast, low-slip lap than in a slow, sliding one.
  const convective = (0.16 + 0.006 * speed) * (st.surfaceTemp - bath);
  st.surfaceTemp += (kw * spec.heatGain - convective -
    (st.surfaceTemp - st.coreTemp) * spec.coolCore) * dt;
  st.coreTemp += ((st.surfaceTemp - st.coreTemp) * spec.coolCore -
    (st.coreTemp - bath) * spec.coolAmbient) * dt;
  // Wear: slip work is the main killer, sustained load a secondary one.
  const loadTerm = 0.00012 * (loadN / spec.refLoad);
  st.wear = clamp(
    st.wear + (spec.wearRate * kw * (0.35 + loadTerm) + loadTerm * 0.25) * dt,
    0, 1,
  );
}

export function rollingRadius(spec: TyreSpec, st: TyreState, pressureBar: number): number {
  // Tyres grow with speed (centrifugal) and with pressure, shrink when hot.
  const grow = 1 + 0.00055 * Math.pow(Math.max(0, st.omega * spec.radius), 2) / 40;
  const dp = pressureBar - spec.pressureOpt;
  return spec.radius * grow * (1 + 0.004 * dp) * (1 - 0.0006 * (st.coreTemp - spec.tempOpt));
}
