import { describe, expect, it } from 'vitest';
import { G } from '../src/core/math.js';
import { makeRig, warmTyres, steadyStateCorner, totalGrip } from './rig.js';
import { FORMULA_PRO, GT3_VENOM, STOCK_CHARGER } from '../src/physics/cars.js';
import { TyreSpec, TyreState, tyreForces, tyreMu } from '../src/physics/tire.js';

function newTyreState(coreTemp: number, wear = 0): TyreState {
  return {
    coreTemp, surfaceTemp: coreTemp, wear, omega: 0, slipEnergy: 0,
    relaxedSlipAngle: 0, relaxedSlipRatio: 0,
  };
}

/** Force with the relaxation state already settled at the demanded slip. */
function settled(
  spec: TyreSpec, st: TyreState,
  load: { fz: number; slipRatio: number; slipAngle: number },
  env: { pressureBar: number; waterDepth: number; speed: number },
) {
  const full: TyreState = { ...st, relaxedSlipAngle: load.slipAngle, relaxedSlipRatio: load.slipRatio };
  return tyreForces(spec, full, {
    fz: load.fz, slipRatio: load.slipRatio, slipAngle: load.slipAngle,
    camber: 0, vx: env.speed, waterDepth: env.waterDepth, surfaceGrip: 1,
  }, { trackTempC: 30, speed: env.speed, pressureBar: env.pressureBar, dt: 0 });
}

describe('tyre model (Pacejka-shaped)', () => {
  const spec = GT3_VENOM.tyreRear;
  const st = newTyreState(spec.tempOpt);

  it('peaks at a small slip angle and then falls away', () => {
    const f = (a: number) => settled(spec, st,
      { fz: spec.refLoad, slipRatio: 0, slipAngle: a },
      { pressureBar: spec.pressureOpt, waterDepth: 0, speed: 30 }).fy;
    // Scan for the peak instead of assuming where it sits.
    let peakAt = 0;
    let peak = 0;
    for (let a = 0.005; a < 0.3; a += 0.005) {
      const v = f(a);
      if (v > peak) {
        peak = v;
        peakAt = a;
      }
    }
    // A racing slick peaks somewhere between 1 and 6 degrees of slip.
    expect(peakAt).toBeGreaterThan(0.015);
    expect(peakAt).toBeLessThan(0.11);
    // The peak must be close to mu*Fz, and grip must fall away after it.
    expect(peak).toBeGreaterThan(spec.muPeak * spec.refLoad * 0.85);
    expect(peak).toBeLessThan(spec.muPeak * spec.refLoad * 1.02);
    // Past the peak the tyre does not go slack: a racing slick settles onto
    // its sliding friction, roughly 70-85% of peak, and holds there. That is
    // why a locked wheel still brakes and a spinning wheel still drives.
    expect(f(peakAt * 3)).toBeLessThan(peak * 0.92);
    expect(f(peakAt * 3)).toBeGreaterThan(peak * 0.55);
    expect(f(0.3)).toBeLessThan(peak * 0.92);
    expect(f(0.3)).toBeGreaterThan(peak * 0.5);
    // Below the peak the force must rise roughly linearly from zero.
    expect(f(0.002)).toBeLessThan(peak * 0.2);
  });

  it('is odd-symmetric (left and right corners behave the same)', () => {
    const f = (a: number) => settled(spec, st,
      { fz: spec.refLoad, slipRatio: 0, slipAngle: a },
      { pressureBar: spec.pressureOpt, waterDepth: 0, speed: 30 }).fy;
    expect(f(0.1)).toBeCloseTo(-f(-0.1), 3);
  });

  it('gives less grip per newton as load rises (load sensitivity)', () => {
    const mu = (fz: number) => tyreMu(spec, st, fz, {
      trackTempC: 30, waterDepth: 0, speed: 30, surfaceGrip: 1,
      pressureBar: spec.pressureOpt,
    });
    const light = mu(spec.refLoad * 0.5);
    const heavy = mu(spec.refLoad * 1.5);
    expect(light).toBeGreaterThan(heavy);
    // Total grip still rises with load, just sub-linearly.
    expect(heavy * spec.refLoad * 1.5).toBeGreaterThan(light * spec.refLoad * 0.5);
  });

  it('loses grip when cold, when overheated, and when worn', () => {
    const env = {
      trackTempC: 30, waterDepth: 0, speed: 30, surfaceGrip: 1,
      pressureBar: spec.pressureOpt,
    };
    const opt = tyreMu(spec, st, spec.refLoad, env);
    const cold = tyreMu(spec, newTyreState(spec.tempOpt - 45), spec.refLoad, env);
    const hot = tyreMu(spec, newTyreState(spec.tempOpt + 60), spec.refLoad, env);
    const worn = tyreMu(spec, newTyreState(spec.tempOpt, 0.8), spec.refLoad, env);
    expect(cold).toBeLessThan(opt);
    expect(hot).toBeLessThan(opt);
    expect(worn).toBeLessThan(opt * 0.7);
  });

  it('hydroplanes: deep water at speed destroys grip', () => {
    const env = {
      trackTempC: 20, speed: 28, surfaceGrip: 1, pressureBar: spec.pressureOpt,
    };
    const dry = tyreMu(spec, st, spec.refLoad, { ...env, waterDepth: 0 });
    const wet = tyreMu(spec, st, spec.refLoad, { ...env, waterDepth: 0.5 });
    const flooded = tyreMu(spec, st, spec.refLoad, { ...env, waterDepth: 3 });
    expect(wet).toBeLessThan(dry);
    expect(flooded).toBeLessThan(wet * 0.5);
    // At walking pace the water barely matters.
    const slow = tyreMu(spec, st, spec.refLoad, { ...env, speed: 2, waterDepth: 3 });
    expect(slow).toBeGreaterThan(flooded);
  });

  it('wrong pressure costs grip both ways', () => {
    const env = { trackTempC: 30, waterDepth: 0, speed: 30, surfaceGrip: 1 };
    const opt = tyreMu(spec, st, spec.refLoad, { ...env, pressureBar: spec.pressureOpt });
    const soft = tyreMu(spec, st, spec.refLoad, { ...env, pressureBar: spec.pressureOpt - 0.6 });
    const hard = tyreMu(spec, st, spec.refLoad, { ...env, pressureBar: spec.pressureOpt + 0.6 });
    expect(soft).toBeLessThan(opt);
    expect(hard).toBeLessThan(opt);
  });

  it('combined slip: braking hard removes cornering grip', () => {
    const load = (sr: number, sa: number) => settled(spec, st,
      { fz: spec.refLoad, slipRatio: sr, slipAngle: sa },
      { pressureBar: spec.pressureOpt, waterDepth: 0, speed: 30 });
    const pureCorner = load(0, 0.1).fy;
    const braking = load(-0.4, 0.1).fy;
    expect(Math.abs(braking)).toBeLessThan(Math.abs(pureCorner) * 0.75);
    expect(Math.abs(load(-0.4, 0).fx)).toBeGreaterThan(0);
  });
});

describe('straight line performance', () => {
  it('accelerates from rest and 0-100 km/h is in a believable window', () => {
    const rig = makeRig({ spec: GT3_VENOM, setup: { tcLevel: 1, throttleMap: 1 } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    // Driven the way a driver launches: hold the rear tyres just at the edge
    // of traction instead of pinning the throttle, which only ever produces
    // wheelspin and a spin. No car does 0-100 with the pedal welded down.
    let t100 = -1;
    const steps = Math.round(8 / (1 / 500));
    for (let i = 0; i < steps; i++) {
      const slip = Math.max(
        rig.car.tyres[2].relaxedSlipRatio, rig.car.tyres[3].relaxedSlipRatio);
      // A slick peaks around 10-15% slip, so hold it there. Open the throttle
      // first and let the slip feedback pull it back, otherwise the launch
      // creeps and never reaches 100 km/h in the window.
      const target = 0.15;
      // Rate per second, not per step: at 500 Hz a per-step gain reaches full
      // throttle in a few hundredths of a second, which is just flooring it.
      const want = i < 25 ? 1 : rig.input.throttle;
      rig.input.throttle = Math.max(0.05,
        Math.min(1, want + (target - slip) * 22 * (1 / 500)));
      rig.runAuto(1 / 500, { autoGear: true });
      if (t100 < 0 && kmhLocal(rig.car.speed) >= 100) t100 = rig.t;
    }
    expect(t100).toBeGreaterThan(2.2);
    expect(t100).toBeLessThan(5.0);
  });

  it('reaches a finite top speed where drag beats power, and it is plausible', () => {
    const rig = makeRig({ spec: GT3_VENOM, setup: { throttleMap: 1 } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    // Terminal speed is a drag-versus-power question, so measure it from a
    // rolling start in top gear. Launching from rest in top gear is something
    // no engine can do, and launching in first just measures wheelspin.
    rig.car.gear = rig.car.gearCount();
    rig.car.place(0, 0, 0, 62);
    rig.car.rpm = 7000;
    rig.input.throttle = 1;
    rig.runAuto(40, { autoGear: false });
    const top = kmhLocal(rig.car.speed);
    expect(top).toBeGreaterThan(250);
    expect(top).toBeLessThan(330);
    // Speed must be settled, not still climbing.
    const v1 = rig.car.speed;
    rig.runAuto(6, { autoGear: false });
    expect(Math.abs(rig.car.speed - v1)).toBeLessThan(1.5);
  });

  it('a low-drag formula car is faster in a straight line than a GT3', () => {
    const f = makeRig({ spec: FORMULA_PRO, setup: { throttleMap: 1 } });
    const g = makeRig({ spec: GT3_VENOM, setup: { throttleMap: 1 } });
    warmTyres(f.car, FORMULA_PRO.tyreRear.tempOpt);
    warmTyres(g.car, GT3_VENOM.tyreRear.tempOpt);
    for (const r of [f, g]) {
      r.car.gear = r.car.gearCount();
      r.car.place(0, 0, 0, 62);
      r.car.rpm = 7000;
      r.input.throttle = 1;
    }
    f.runAuto(40, { autoGear: false });
    g.runAuto(40, { autoGear: false });
    expect(f.car.speed).toBeGreaterThan(g.car.speed);
  });

  it('a front-heavy stock car tops out lower still', () => {
    const s = makeRig({ spec: STOCK_CHARGER, setup: { throttleMap: 1 } });
    warmTyres(s.car, STOCK_CHARGER.tyreRear.tempOpt);
    s.car.gear = s.car.gearCount();
    s.car.place(0, 0, 0, 62);
    s.car.rpm = 7000;
    s.input.throttle = 1;
    s.runAuto(40, { autoGear: false });
    expect(kmhLocal(s.car.speed)).toBeGreaterThan(280);
    expect(kmhLocal(s.car.speed)).toBeLessThan(360);
  });

  it('engine braking slows the car with no pedal input', () => {
    const rig = makeRig({ spec: GT3_VENOM, speed: 45 });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.car.gear = 3;
    const before = rig.car.speed;
    rig.run(2);
    expect(rig.car.speed).toBeLessThan(before);
    expect(rig.car.speed).toBeGreaterThan(before - 20);
  });
});

describe('braking', () => {
  const brakeDistance = (abs: number, from = 50): number => {
    const rig = makeRig({ spec: GT3_VENOM, speed: from, setup: { absLevel: abs } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.car.gear = 4;
    rig.input.brake = 1;
    const x0 = rig.car.x;
    rig.run(8);
    return rig.car.x - x0;
  };

  it('stops a GT3 from 180 km/h inside a believable distance', () => {
    const d = brakeDistance(0.5);
    // mu ~1.45 => ideal 47 m; real cars with aero and fade land near that.
    expect(d).toBeGreaterThan(35);
    expect(d).toBeLessThan(75);
  });

  it('ABS beats a locked axle', () => {
    const withAbs = brakeDistance(0.5);
    const locked = brakeDistance(0);
    expect(withAbs).toBeLessThan(locked);
  });

  it('moving the brake bias rearwards makes the car less stable under braking', () => {
    const frontBias = makeRig({ spec: GT3_VENOM, speed: 45, setup: { brakeBias: 0.62, absLevel: 0 } });
    const rearBias = makeRig({ spec: GT3_VENOM, speed: 45, setup: { brakeBias: 0.42, absLevel: 0 } });
    warmTyres(frontBias.car, GT3_VENOM.tyreRear.tempOpt);
    warmTyres(rearBias.car, GT3_VENOM.tyreRear.tempOpt);
    frontBias.input.brake = 1;
    rearBias.input.brake = 1;
    frontBias.run(1.6);
    rearBias.run(1.6);
    expect(Math.abs(rearBias.car.slipAngleBody)).toBeGreaterThan(
      Math.abs(frontBias.car.slipAngleBody));
  });

  it('brakes fade when they get hot', () => {
    const rig = makeRig({ spec: GT3_VENOM, speed: 55, setup: { absLevel: 0.5 } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.car.gear = 4;
    rig.car.brakeTemp = 700;
    rig.input.brake = 1;
    const x0 = rig.car.x;
    rig.run(4);
    const hot = rig.car.x - x0;
    const cold = brakeDistance(0.5, 55);
    expect(hot).toBeGreaterThan(cold);
  });
});

describe('cornering', () => {
  it('holds a steady 60 m radius at a plausible lateral acceleration', () => {
    const r = steadyStateCorner(GT3_VENOM, {}, 60, 26);
    expect(r.latG).toBeGreaterThan(0.8);
    expect(r.latG).toBeLessThan(2.4);
    // The yaw rate should be close to v/R once settled.
    expect(r.yawRate).toBeCloseTo(26 / 60, 1);
  });

  it('a formula car carries far more corner speed than a GT3', () => {
    const f = steadyStateCorner(FORMULA_PRO, {}, 100, 45);
    const g = steadyStateCorner(GT3_VENOM, {}, 100, 45);
    expect(f.latG).toBeGreaterThan(g.latG * 1.25);
  });

  it('downforce grows the cornering grip with speed', () => {
    const slow = steadyStateCorner(FORMULA_PRO, {}, 120, 25);
    const fast = steadyStateCorner(FORMULA_PRO, {}, 120, 55);
    expect(fast.latG).toBeGreaterThan(slow.latG * 1.4);
    // And the numbers should not exceed what the tyres can physically give.
    expect(fast.latG).toBeLessThan(totalGrip(FORMULA_PRO, 55) * 1.05);
  });

  it('more rear wing buys cornering grip at the cost of straight line speed', () => {
    const low = steadyStateCorner(FORMULA_PRO, { wingRear: 4, wingFront: 4 }, 100, 45);
    const high = steadyStateCorner(FORMULA_PRO, { wingRear: 30, wingFront: 16 }, 100, 45);
    expect(high.latG).toBeGreaterThan(low.latG);
    const sl = (wing: number) => {
      const rig = makeRig({ spec: FORMULA_PRO, speed: 60, setup: { wingRear: wing, wingFront: wing * 0.5 } });
      warmTyres(rig.car, FORMULA_PRO.tyreRear.tempOpt);
      rig.car.gear = rig.car.gearCount();
      rig.input.throttle = 1;
      rig.runAuto(12, { autoGear: false });
      return rig.car.speed;
    };
    expect(sl(4)).toBeGreaterThan(sl(30));
  });

  it('softer anti-roll bars at the front push the balance towards understeer', () => {
    // Understeer shows up as a yaw rate below the kinematic v/R for a given steer.
    const soft = steadyStateCorner(GT3_VENOM, { arbFront: 0.4, arbRear: 1.6 }, 80, 30);
    const stiff = steadyStateCorner(GT3_VENOM, { arbFront: 1.6, arbRear: 0.4 }, 80, 30);
    expect(Math.abs(soft.yawRate)).toBeLessThan(Math.abs(stiff.yawRate));
  });

  it('off track on grass the car slows down and loses grip', () => {
    const onTrack = makeRig({ spec: GT3_VENOM, speed: 40 });
    const offTrack = makeRig({
      spec: GT3_VENOM, speed: 40,
      surfaces: { grip: 0.42, rollingResist: 0.09 },
    });
    warmTyres(onTrack.car, GT3_VENOM.tyreRear.tempOpt);
    warmTyres(offTrack.car, GT3_VENOM.tyreRear.tempOpt);
    onTrack.run(3);
    offTrack.run(3);
    expect(offTrack.car.speed).toBeLessThan(onTrack.car.speed * 0.8);
  });

  it('wet track cuts the achievable lateral acceleration', () => {
    const dry = steadyStateCorner(GT3_VENOM, {}, 80, 26);
    const rig = makeRig({
      spec: GT3_VENOM, speed: 26,
      surfaces: { grip: 0.62, waterDepth: 0.6 },
      env: { rainMmH: 6 },
    });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.input.throttle = 0.3;
    const k = 1 / 80;
    const dt = 1 / 500;
    for (let i = 0; i < 6 / dt; i++) {
      const err = 26 * k - rig.car.yawRate;
      rig.input.steer = Math.max(-1, Math.min(1, rig.input.steer * 0.9 + err * 44 * dt));
      rig.run(dt);
    }
    const wet = Math.abs(rig.car.accelLat) / G;
    expect(wet).toBeLessThan(Math.abs(dry.latG) * 0.75);
  });
});

describe('thermal and wear progression', () => {
  it('driving hard heats the tyres up and wears them out', () => {
    const rig = makeRig({ spec: GT3_VENOM, speed: 40, setup: { throttleMap: 1 } });
    warmTyres(rig.car, 45);
    rig.car.gear = 3;
    rig.input.throttle = 1;
    const wear0 = rig.car.tyreWear[3];
    rig.runAuto(30, { autoGear: true });
    expect(rig.car.tyreTemps[3]).toBeGreaterThan(60);
    expect(rig.car.tyreWear[3]).toBeGreaterThan(wear0);
  });

  it('a cold tyre gives less grip than a hot one on the same corner', () => {
    const cold = steadyStateCorner(GT3_VENOM, {}, 70, 28);
    const rig = makeRig({ spec: GT3_VENOM, speed: 28 });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt + 40);
    rig.input.throttle = 0.35;
    const k = 1 / 70;
    const dt = 1 / 500;
    for (let i = 0; i < 6 / dt; i++) {
      const err = 28 * k - rig.car.yawRate;
      rig.input.steer = Math.max(-1, Math.min(1, rig.input.steer * 0.9 + err * 44 * dt));
      rig.run(dt);
    }
    const hot = Math.abs(rig.car.accelLat) / G;
    expect(hot).toBeGreaterThan(Math.abs(cold.latG) * 0.95);
  });

  it('fuel burn reduces mass over a stint', () => {
    const rig = makeRig({ spec: GT3_VENOM, setup: { throttleMap: 1 } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.car.gear = 3;
    rig.input.throttle = 1;
    const f0 = rig.car.fuelL;
    rig.runAuto(60);
    expect(rig.car.fuelL).toBeLessThan(f0);
    expect(rig.car.fuelL).toBeGreaterThan(0);
  });
});

describe('transmission and differential', () => {
  it('shifts up through the box and the rpm drops on each shift', () => {
    const rig = makeRig({ spec: GT3_VENOM, setup: { throttleMap: 1, tcLevel: 1 } });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.input.throttle = 1;
    const rpms: number[] = [];
    let lastGear = 1;
    rig.car.gear = 1;
    for (let i = 0; i < 40 / (1 / 500); i++) {
      rig.runAuto(1 / 500);
      if (rig.car.gear !== lastGear) {
        rpms.push(rig.car.rpm);
        lastGear = rig.car.gear;
      }
    }
    expect(lastGear).toBeGreaterThanOrEqual(rig.car.gearCount() - 1);
    // Every recorded shift should have happened high in the rev range.
    for (const r of rpms) expect(r).toBeGreaterThan(rig.car.spec.engine.redlineRpm * 0.7);
  });

  it('a shorter final drive lowers the top speed', () => {
    const top = (fd: number) => {
      const rig = makeRig({ spec: GT3_VENOM, setup: { finalDrive: fd, throttleMap: 1 } });
      warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
      rig.car.gear = rig.car.gearCount();
      rig.input.throttle = 1;
      rig.runAuto(40, { autoGear: false });
      return rig.car.speed;
    };
    expect(top(3.3)).toBeGreaterThan(top(4.6));
  });

  it('reverse moves the car backwards', () => {
    const rig = makeRig({ spec: GT3_VENOM });
    warmTyres(rig.car, GT3_VENOM.tyreRear.tempOpt);
    rig.car.gear = -1;
    rig.input.throttle = 0.5;
    rig.input.clutch = 0;
    rig.run(2);
    expect(rig.car.vxLocal).toBeLessThan(-0.5);
  });
});

describe('numerical robustness', () => {
  it('never produces NaN or Infinity in an abusive scenario', () => {
    const rig = makeRig({ spec: FORMULA_PRO, speed: 70, setup: { throttleMap: 1, absLevel: 0 } });
    warmTyres(rig.car, FORMULA_PRO.tyreRear.tempOpt);
    rig.car.gear = 2;
    rig.input.throttle = 1;
    rig.input.brake = 1;
    rig.input.steer = 1;
    for (let i = 0; i < 30 / (1 / 500); i++) {
      rig.input.steer = i % 37 < 18 ? 1 : -1;
      rig.run(1 / 500);
      const c = rig.car;
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
      expect(Number.isFinite(c.vx)).toBe(true);
      expect(Number.isFinite(c.yawRate)).toBe(true);
      expect(Math.abs(c.vxLocal)).toBeLessThan(150);
      expect(Math.abs(c.yawRate)).toBeLessThan(25);
    }
  });

  it('a stationary car on a slope does not accelerate away by itself', () => {
    const rig = makeRig({ spec: GT3_VENOM, surfaces: { slopeAlong: 0.05 } });
    rig.input.brake = 1;
    rig.run(3);
    expect(Math.abs(rig.car.speed)).toBeLessThan(2);
  });
});

function kmhLocal(v: number): number {
  return v * 3.6;
}
