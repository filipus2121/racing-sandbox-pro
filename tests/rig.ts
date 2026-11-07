import { describe, expect, it } from 'vitest';
import { G, Rng } from '../src/core/math.js';
import {
  CarSetup, Environment, defaultEnvironment, defaultSetup, effectiveMass,
} from '../src/physics/cars.js';
import { CarSpec } from '../src/physics/types.js';
import {
  CarInput, NEUTRAL_SURFACE, SurfaceSample, Vehicle, kmh, stepVehicle,
} from '../src/physics/vehicle.js';
import { tyreForces, tyreMu } from '../src/physics/tire.js';
import { FORMULA_PRO, GT3_VENOM, STOCK_CHARGER } from '../src/physics/cars.js';

export interface RigOptions {
  spec?: CarSpec;
  setup?: Partial<CarSetup>;
  env?: Partial<Environment>;
  surfaces?: Partial<SurfaceSample>;
  speed?: number;
  heading?: number;
  x?: number;
  y?: number;
  /** Starting gear. Defaults to 1st; use 0 for neutral. */
  gear?: number;
}

export interface Rig {
  car: Vehicle;
  input: CarInput;
  env: Environment;
  surfaces: SurfaceSample[];
  /** Run `seconds` of simulated time at a fixed 500 Hz step. */
  run(seconds: number): void;
  /** Run with an auto gearbox and a helper that keeps the car in its power band. */
  runAuto(seconds: number, opts?: { autoGear?: boolean }): void;
  t: number;
}

const DT = 1 / 500;

export function makeRig(opts: RigOptions = {}): Rig {
  const spec = opts.spec ?? GT3_VENOM;
  const setup: CarSetup = { ...defaultSetup(spec), ...(opts.setup ?? {}) };
  const env: Environment = { ...defaultEnvironment, ...(opts.env ?? {}) };
  const surfaces: SurfaceSample[] = [0, 1, 2, 3].map(() => ({
    ...NEUTRAL_SURFACE, ...(opts.surfaces ?? {}),
  }));
  const car = new Vehicle(spec, setup);
  car.place(opts.x ?? 0, opts.y ?? 0, opts.heading ?? 0, opts.speed ?? 0);
  car.gear = opts.gear ?? 1;
  car.rpm = spec.engine.idleRpm;
  for (let i = 0; i < 4; i++) car.setSurface(i, surfaces[i]);
  const input: CarInput = {
    throttle: 0, brake: 0, steer: 0, clutch: 0,
    shiftUp: false, shiftDown: false, handbrake: 0,
  };
  let shiftHold = 0;
  const rig: Rig = {
    car,
    input,
    env,
    surfaces,
    t: 0,
    run(seconds: number) {
      const steps = Math.round(seconds / DT);
      for (let i = 0; i < steps; i++) {
        stepVehicle(car, input, env, DT);
        rig.t += DT;
      }
    },
    runAuto(seconds: number, o?: { autoGear?: boolean }) {
      const steps = Math.round(seconds / DT);
      const autoGear = o?.autoGear ?? true;
      // Held on the rig, not in a local: callers drive this one 500 Hz step at
      // a time, and a local would reset every call, defeating the hold.
      for (let i = 0; i < steps; i++) {
        input.shiftUp = false;
        input.shiftDown = false;
        if (autoGear && shiftHold <= 0) {
          const redline = car.spec.engine.redlineRpm;
          if (car.rpm > redline * 0.93 && car.gear >= 1 && car.gear < car.gearCount()) {
            input.shiftUp = true;
            shiftHold = 0.06;
          } else if (car.rpm < redline * 0.4 && car.gear > 1) {
            input.shiftDown = true;
            shiftHold = 0.09;
          } else if (car.gear === 0) {
            input.shiftUp = true;
            shiftHold = 0.2;
          }
        }
        shiftHold -= DT;
        stepVehicle(car, input, env, DT);
        rig.t += DT;
      }
    },
  };
  return rig;
}

/** Bring the tyres up to a representative working temperature. */
export function warmTyres(car: Vehicle, targetC: number): void {
  for (const t of car.tyres) {
    t.coreTemp = targetC;
    t.surfaceTemp = targetC;
  }
}

export function steadyStateCorner(
  spec: CarSpec, setup: Partial<CarSetup>, radius: number, speed: number,
): { latG: number; steerRad: number; yawRate: number } {
  const rig = makeRig({ spec, setup, speed });
  warmTyres(rig.car, spec.tyreRear.tempOpt);
  const k = 1 / radius;
  rig.input.throttle = 0.35;
  // PI controller on the yaw-rate error, so the car actually settles on the
  // demanded radius instead of stopping short of it.
  let integral = 0;
  const drive = () => {
    const err = speed * k - rig.car.yawRate;
    integral = Math.max(-0.4, Math.min(0.4, integral + err * 0.35 * DT));
    rig.input.steer = Math.max(-1, Math.min(1, err * 0.55 + integral));
    stepVehicle(rig.car, rig.input, rig.env, DT);
  };
  for (let i = 0; i < Math.round(6 / DT); i++) drive();
  // Average the last second to reject transients.
  let latSum = 0;
  let yawSum = 0;
  const n = Math.round(1 / DT);
  for (let i = 0; i < n; i++) {
    drive();
    latSum += rig.car.speed * rig.car.yawRate;
    yawSum += rig.car.yawRate;
  }
  return {
    latG: (latSum / n) / G,
    steerRad: rig.car.steeringAngle,
    yawRate: yawSum / n,
  };
}

export function rng(seed: number): Rng {
  return new Rng(seed);
}

export function totalGrip(spec: CarSpec, speed: number): number {
  const setup = defaultSetup(spec);
  const m = effectiveMass(spec, setup, setup.fuelLoadL);
  const v2 = (speed * speed) / (27.7778 * 27.7778);
  const df = (spec.aero.downforceFront100 + spec.aero.downforceRear100) * v2;
  return (spec.tyreRear.muPeak * (m * G + df)) / (m * G);
}

export { FORMULA_PRO, GT3_VENOM, STOCK_CHARGER, kmh, tyreForces, tyreMu };

describe('test rig sanity', () => {
  it('produces a car at rest in neutral that stays at rest', () => {
    const rig = makeRig({ gear: 0 });
    rig.run(2);
    expect(rig.car.speed).toBeLessThan(0.01);
    expect(Math.abs(rig.car.x)).toBeLessThan(0.02);
    expect(Number.isFinite(rig.car.x)).toBe(true);
  });

  it('creeps only slightly in gear with no throttle, like a real clutch', () => {
    const rig = makeRig({ gear: 1 });
    rig.run(2);
    expect(rig.car.speed).toBeLessThan(2);
  });
});
