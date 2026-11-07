import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/math.js';
import { Track, SURFACE_GRASS } from '../src/track/track.js';
import { computeRacingLine, computeSpeedProfile, estimateLapTime } from '../src/track/racingLine.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';

describe('track geometry', () => {
  const circle = (radius: number, n = 200): Track => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    return Track.fromPolyline(pts, 14);
  };

  it('measures the length of a circle correctly', () => {
    const t = circle(100);
    expect(t.totalLength).toBeCloseTo(2 * Math.PI * 100, 0);
  });

  it('reports the curvature of a circle correctly', () => {
    const t = circle(100);
    const k = t.curvature[10];
    expect(Math.abs(k)).toBeCloseTo(1 / 100, 3);
  });

  it('closes the loop and turns through 2*pi', () => {
    const t = circle(100);
    expect(t.isClosedLoop()).toBe(true);
    expect(Math.abs(t.totalTurning())).toBeCloseTo(Math.PI * 2, 1);
  });

  it('finds the nearest centreline index and the lateral offset', () => {
    const t = circle(100);
    const q = t.query(100, 0);
    expect(Math.abs(q.lateral)).toBeLessThan(0.5);
    expect(q.onTrack).toBe(true);
    const outside = t.query(130, 0);
    expect(outside.onTrack).toBe(false);
    expect(outside.grip).toBeLessThan(0.6);
    expect(outside.rollingResist).toBeGreaterThan(0.02);
  });

  it('maps s and lateral back to a world position consistently', () => {
    const t = circle(100);
    const p = t.pointAt(250, 3);
    const q = t.query(p.x, p.y);
    expect(q.lateral).toBeCloseTo(3, 1);
    expect(q.s).toBeCloseTo(250, 0);
  });

  it('all presets build into closed loops', () => {
    for (const preset of TRACK_PRESETS) {
      const t = buildPresetTrack(preset);
      expect(t.isClosedLoop(), preset.name).toBe(true);
      expect(t.totalLength).toBeGreaterThan(1000);
      expect(Number.isFinite(t.totalLength)).toBe(true);
    }
  });

  it('painting a surface changes the grip a car gets there', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const q0 = t.query(t.xs[10], t.ys[10]);
    t.setSurfaceAt(t.xs[10], t.ys[10], SURFACE_GRASS, 20);
    t.refresh();
    const q1 = t.query(t.xs[10], t.ys[10]);
    expect(q1.grip).toBeLessThan(q0.grip);
  });

  it('rain fills the track with water and dry weather clears it', () => {
    const t = buildPresetTrack(TRACK_PRESETS[1]);
    // 90 s of 12 mm/h rain builds a ~0.2 mm film against a ~0.4 mm equilibrium.
    for (let i = 0; i < 900; i++) t.updateWeather(0.1, 12);
    expect(t.water[0]).toBeGreaterThan(0.1);
    // Four minutes without rain clears it back through the same time constant.
    for (let i = 0; i < 2400; i++) t.updateWeather(0.1, 0);
    expect(t.water[0]).toBeLessThan(0.05);
  });

  it('rubber builds up on the racing line and adds grip there', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const before = t.query(t.xs[50], t.ys[50]).grip;
    for (let i = 0; i < 200; i++) t.addRubber(50, 0.01);
    const after = t.query(t.xs[50], t.ys[50]).grip;
    expect(after).toBeGreaterThan(before);
  });

  it('serialises and reloads identically', () => {
    const t = buildPresetTrack(TRACK_PRESETS[3]);
    t.setWidthAt(t.xs[20], t.ys[20], 18, 30);
    const json = JSON.parse(JSON.stringify(t.toJSON()));
    const t2 = Track.fromJSON(json);
    expect(t2.totalLength).toBeCloseTo(t.totalLength, 3);
    expect(t2.width[20]).toBeCloseTo(t.width[20], 6);
  });

  it('the spatial index agrees with a brute force search', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const rng = new Rng(42);
    for (let i = 0; i < 60; i++) {
      const s = rng.range(0, t.totalLength);
      const lat = rng.range(-20, 20);
      const p = t.pointAt(s, lat);
      const fast = t.nearestIndex(p.x, p.y);
      let bestD = Infinity;
      for (let j = 0; j < t.xs.length; j++) {
        const d = (t.xs[j] - p.x) ** 2 + (t.ys[j] - p.y) ** 2;
        if (d < bestD) bestD = d;
      }
      const dFast = (t.xs[fast] - p.x) ** 2 + (t.ys[fast] - p.y) ** 2;
      expect(dFast).toBeLessThanOrEqual(bestD * 1.0001 + 1e-6);
    }
  });
});

describe('racing line and speed profile', () => {
  it('keeps the line inside the tarmac', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8 });
    for (let i = 0; i < line.lateral.length; i++) {
      const limit = t.width[i] * 0.5 - 1.0 - 0.8 + 0.01;
      expect(Math.abs(line.lateral[i])).toBeLessThanOrEqual(limit);
    }
  });

  it('cuts the curvature compared to following the centreline', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8 });
    const sum = (a: number[]) => a.reduce((x, y) => x + Math.abs(y), 0);
    const centre = t.curvature.map(Math.abs);
    expect(sum(line.curvature)).toBeLessThan(sum(centre));
  });

  it('produces a speed profile with slow corners and fast straights', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8 });
    const speeds = computeSpeedProfile(t, line, 2.2 * 9.81, 18, 9, 90);
    const min = Math.min(...speeds);
    const max = Math.max(...speeds);
    expect(max).toBeGreaterThan(min * 1.8);
    expect(min).toBeGreaterThan(8);
    // Speed must be continuous: no impossible jumps between samples.
    for (let i = 1; i < speeds.length; i++) {
      expect(Math.abs(speeds[i] - speeds[i - 1])).toBeLessThan(20);
    }
  });

  it('a wet track lowers the whole speed profile', () => {
    const t = buildPresetTrack(TRACK_PRESETS[0]);
    const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8 });
    const dry = computeSpeedProfile(t, line, 2.2 * 9.81, 18, 9, 90);
    const wetLine = { ...line, grip: line.grip.map(g => g * 0.65) };
    const wet = computeSpeedProfile(t, wetLine, 2.2 * 9.81, 18, 9, 90);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(wet)).toBeLessThan(avg(dry) * 0.92);
  });

  it('estimates a lap time in a sane range for each preset', () => {
    for (const preset of TRACK_PRESETS) {
      const t = buildPresetTrack(preset);
      const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8 });
      const speeds = computeSpeedProfile(t, line, 2.2 * 9.81, 18, 9, 90);
      const lap = estimateLapTime(t, speeds);
      expect(lap, preset.name).toBeGreaterThan(t.totalLength / 95);
      expect(lap, preset.name).toBeLessThan(t.totalLength / 12);
    }
  });
});
