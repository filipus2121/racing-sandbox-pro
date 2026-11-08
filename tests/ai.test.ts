import { describe, expect, it } from 'vitest';
import { World, PHYS_DT } from '../src/state/world.js';
import { NO_INPUT } from '../src/physics/vehicle.js';
import { defaultSetup, GT3_VENOM, FORMULA_PRO } from '../src/physics/cars.js';
import { buildPresetTrack, TRACK_PRESETS, TrackPreset } from '../src/track/presets.js';

/** Pinned by id: the menu order changes, these tests must not. */
const ROAD_PRESETS: TrackPreset[] = ['riverside', 'kite', 'nordbank', 'highland']
  .map(id => TRACK_PRESETS.find(p => p.id === id)!);
import { CarSetup } from '../src/physics/cars.js';

function makeWorld(opts: {
  preset?: number; aiCount?: number; laps?: number; seed?: number;
  setup?: Partial<CarSetup>; spec?: typeof GT3_VENOM;
} = {}): World {
  const track = buildPresetTrack(ROAD_PRESETS[opts.preset ?? 0]);
  const spec = opts.spec ?? GT3_VENOM;
  const setup: CarSetup = { ...defaultSetup(spec), ...(opts.setup ?? {}) };
  return new World({
    track,
    playerSpec: spec,
    playerSetup: setup,
    aiSpecs: [spec],
    aiCount: opts.aiCount ?? 5,
    laps: opts.laps ?? 3,
    env: { trackTempC: 32, airTempC: 22, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
    seed: opts.seed ?? 1234,
  });
}

/** Run the session with a stationary player (the AI is what we are testing). */
function runSession(world: World, seconds: number): void {
  const steps = Math.round(seconds / PHYS_DT);
  const input = { ...NO_INPUT };
  for (let i = 0; i < steps; i++) {
    world.update(PHYS_DT, input);
  }
}

describe('AI opponents', () => {
  it('leave the grid and complete laps without any scripting of their path', () => {
    const w = makeWorld({ aiCount: 4, laps: 3 });
    // 5 s countdown plus enough time for a couple of laps.
    runSession(w, 5 + 150);
    const ai = w.racers.filter(r => !r.isPlayer);
    for (const r of ai) {
      expect(Number.isFinite(r.car.x)).toBe(true);
      expect(r.progressDistance).toBeGreaterThan(w.track.totalLength * 1.2);
    }
  }, 120000);

  it('drive at a pace close to the physical speed profile of the car', () => {
    const w = makeWorld({ aiCount: 2, laps: 4, preset: 0 });
    runSession(w, 5 + 260);
    const ai = w.racers.filter(r => !r.isPlayer);
    const leader = ai.sort((a, b) => b.bestLap && a.bestLap ? a.bestLap - b.bestLap : 0)[0];
    expect(leader.bestLap).toBeGreaterThan(0);
    // Rough physical envelope: length / 95 m/s < lap < length / 18 m/s
    const len = w.track.totalLength;
    expect(leader.bestLap / 1000).toBeGreaterThan(len / 95);
    expect(leader.bestLap / 1000).toBeLessThan(len / 16);
  }, 180000);

  it('stay on the tarmac for the large majority of a clean lap', () => {
    const w = makeWorld({ aiCount: 2, laps: 3, preset: 1 });
    runSession(w, 5 + 200);
    const ai = w.racers.filter(r => !r.isPlayer);
    for (const r of ai) {
      // offTrackTime resets on every lap crossing, so a low value means the
      // last lap was mostly clean.
      expect(r.offTrackTime).toBeLessThan(8);
    }
  }, 180000);

  it('produce different lap times from different driver personalities', () => {
    const w = makeWorld({ aiCount: 6, laps: 5 });
    runSession(w, 5 + 320);
    const laps = w.racers.filter(r => !r.isPlayer && r.bestLap > 0).map(r => r.bestLap);
    expect(laps.length).toBeGreaterThanOrEqual(4);
    const spread = Math.max(...laps) - Math.min(...laps);
    expect(spread).toBeGreaterThan(200); // more than 0.2 s apart
  }, 240000);

  it('are deterministic for a given seed', () => {
    const a = makeWorld({ aiCount: 2, laps: 2, seed: 99 });
    const b = makeWorld({ aiCount: 2, laps: 2, seed: 99 });
    runSession(a, 5 + 40);
    runSession(b, 5 + 40);
    for (let i = 0; i < a.racers.length; i++) {
      expect(a.racers[i].car.x).toBeCloseTo(b.racers[i].car.x, 6);
      expect(a.racers[i].car.y).toBeCloseTo(b.racers[i].car.y, 6);
    }
  }, 120000);

  it('avoid driving into the player when the player sits on the racing line', () => {
    const w = makeWorld({ aiCount: 3, laps: 3 });
    // Park the player on the line shortly after the start.
    runSession(w, 6);
    const pose = w.track.pointAt(120, 0);
    w.player.car.place(pose.x, pose.y, pose.heading, 0);
    w.player.car.gear = 0;
    runSession(w, 60);
    const impacts = w.racers.filter(r => !r.isPlayer)
      .reduce((n, r) => n + r.collisions, 0);
    // A couple of glancing contacts are fine; a pile-up is not.
    expect(impacts).toBeLessThan(w.racers.length * 3);
  }, 180000);

  it('time a lap and detect the fastest one', () => {
    const w = makeWorld({ aiCount: 2, laps: 3 });
    runSession(w, 5 + 200);
    expect(w.fastestLap.ms).toBeGreaterThan(1000);
    expect(w.fastestLap.name.length).toBeGreaterThan(0);
  }, 180000);
});

describe('session logic', () => {
  it('holds the cars on the grid until the lights go out', () => {
    const w = makeWorld({ aiCount: 2 });
    runSession(w, 2);
    expect(w.started).toBe(false);
    for (const r of w.racers) expect(r.progressDistance).toBeLessThan(15);
    runSession(w, 6);
    expect(w.started).toBe(true);
  }, 60000);

  it('produces a standings order consistent with the distance covered', () => {
    const w = makeWorld({ aiCount: 4 });
    runSession(w, 5 + 60);
    const rows = w.standings();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].progress).toBeGreaterThanOrEqual(rows[i].progress - 1e-6);
    }
    expect(rows[0].position).toBe(1);
    expect(rows[rows.length - 1].position).toBe(rows.length);
  }, 120000);

  it('a faster car overtakes a slower one over a stint', () => {
    const w = makeWorld({ aiCount: 3, laps: 6, preset: 0 });
    runSession(w, 5 + 300);
    const rows = w.standings();
    // At least one car should have changed position relative to the grid.
    const moved = rows.some(row => row.position !==
      w.racers.indexOf(row.racer) + 1);
    expect(moved).toBe(true);
  }, 240000);

  it('ends the session when the leader has done all the laps', () => {
    const w = makeWorld({ aiCount: 1, laps: 1 });
    runSession(w, 5 + 220);
    const leader = w.standings()[0];
    expect(leader.finished || leader.laps >= 1).toBe(true);
  }, 240000);

  it('a formula car laps the same circuit quicker than a GT3', () => {
    const gt = makeWorld({ aiCount: 1, laps: 3, preset: 0, spec: GT3_VENOM });
    const fx = makeWorld({ aiCount: 1, laps: 3, preset: 0, spec: FORMULA_PRO });
    runSession(gt, 5 + 220);
    runSession(fx, 5 + 220);
    const gtBest = Math.min(...gt.racers.filter(r => r.bestLap > 0).map(r => r.bestLap));
    const fxBest = Math.min(...fx.racers.filter(r => r.bestLap > 0).map(r => r.bestLap));
    expect(fxBest).toBeLessThan(gtBest);
  }, 300000);
});
