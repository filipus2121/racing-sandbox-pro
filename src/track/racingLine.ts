import { G, clamp } from '../core/math.js';
import { Track } from './track.js';

export interface RacingLine {
  /** Lateral offset per centreline sample, m (positive = left). */
  lateral: number[];
  /** Curvature of the chosen line per sample, 1/m. */
  curvature: number[];
  /** Maximum sustainable speed per sample, m/s. */
  speedLimit: number[];
  /** Grip multiplier per sample that produced the limit. */
  grip: number[];
  /** Car half width + margin used to keep the car on the tarmac. */
  margin: number;
}

/**
 * Compute a curvature-minimising racing line by relaxing the lateral offsets.
 * This is the same principle a real driver uses: straighten the corner as
 * much as the track allows. No "rails" - the line is derived from geometry.
 */
export function computeRacingLine(
  track: Track,
  opts: {
    carHalfWidth?: number;
    margin?: number;
    iterations?: number;
    /** 0 = centreline, 1 = full use of the track width. */
    usage?: number;
  } = {},
): RacingLine {
  const n = track.xs.length;
  const halfWidth = opts.carHalfWidth ?? 1.0;
  const margin = opts.margin ?? 0.9;
  const usage = clamp(opts.usage ?? 0.92, 0, 1);
  const limit = (i: number) =>
    Math.max(0.4, track.width[i] * 0.5 - halfWidth - margin) * usage;

  const lat = new Float64Array(n);
  const curvature = new Float64Array(n);

  // World position of the candidate line.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const fill = () => {
    for (let i = 0; i < n; i++) {
      const h = track.heading[i];
      px[i] = track.xs[i] - Math.sin(h) * lat[i];
      py[i] = track.ys[i] + Math.cos(h) * lat[i];
    }
  };

  fill();
  const iterations = opts.iterations ?? 260;
  // Small steps. Every point is relaxed against neighbours that are moving at
  // the same time, so a large step overshoots and the line develops a
  // high-frequency zigzag that adds curvature instead of removing it -- the
  // opposite of what a racing line is for.
  const step = Math.max(0.02, track.maxSegmentLength() * 0.04);

  for (let it = 0; it < iterations; it++) {
    // Curvature of the polyline through the candidate points.
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const ax = px[i] - px[a];
      const ay = py[i] - py[a];
      const bx = px[b] - px[i];
      const by = py[b] - py[i];
      const cross = ax * by - ay * bx;
      const dot = ax * bx + ay * by;
      const len = Math.max(1e-6, Math.hypot(ax, ay) * Math.hypot(bx, by));
      const ds = (Math.hypot(ax, ay) + Math.hypot(bx, by)) * 0.5;
      curvature[i] = cross / (len * ds) * (dot < 0 ? 2 : 1);
    }
    // Move each point sideways to reduce the local curvature.
    const cooling = 1 - it / iterations * 0.85;
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const c = (curvature[a] + curvature[b]) * 0.5 - curvature[i] * 0.5;
      const h = track.heading[i];
      // Moving left (+lateral) changes curvature with a sign given by the
      // local geometry; measure it numerically to stay robust.
      const nx = -Math.sin(h);
      const ny = Math.cos(h);
      const probe = step * 0.5;
      const curvWith = probeCurvature(px, py, n, i, nx * probe, ny * probe);
      const curvWithout = probeCurvature(px, py, n, i, -nx * probe, -ny * probe);
      const dir = Math.abs(curvWith) < Math.abs(curvWithout) ? 1 : -1;
      const gain = clamp(Math.abs(c) * 40, 0, 1);
      lat[i] += dir * step * gain * cooling;
      lat[i] = clamp(lat[i], -limit(i), limit(i));
    }
    // Light lateral smoothing each sweep, so residual zigzag is damped out
    // rather than being amplified by the next independent move.
    const smoothed = Float64Array.from(lat);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      smoothed[i] = clamp(lat[i] * 0.6 + (lat[a] + lat[b]) * 0.2,
        -limit(i), limit(i));
    }
    for (let i = 0; i < n; i++) {
      lat[i] = smoothed[i];
      const nx = -Math.sin(track.heading[i]);
      const ny = Math.cos(track.heading[i]);
      px[i] = track.xs[i] + nx * lat[i];
      py[i] = track.ys[i] + ny * lat[i];
    }
  }
  fill();
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const ax = px[i] - px[a];
    const ay = py[i] - py[a];
    const bx = px[b] - px[i];
    const by = py[b] - py[i];
    const cross = ax * by - ay * bx;
    const len = Math.max(1e-6, Math.hypot(ax, ay) * Math.hypot(bx, by));
    const ds = (Math.hypot(ax, ay) + Math.hypot(bx, by)) * 0.5;
    curvature[i] = cross / (len * ds);
  }

  // Grip available on the line (water, marbles, rubber, banking).
  const grip = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = track.heading[i];
    const x = track.xs[i] - Math.sin(h) * lat[i];
    const y = track.ys[i] + Math.cos(h) * lat[i];
    const q = track.query(x, y);
    let g = clamp(q.grip, 0.2, 1.4);
    // Banking helps a car going the "right" way around a banked corner.
    const bankHelp = 1 + Math.sign(track.curvature[i]) * Math.sin(track.bankAt(i)) * 0.8;
    g *= clamp(bankHelp, 0.7, 1.35);
    grip[i] = g;
  }

  return {
    lateral: Array.from(lat),
    curvature: Array.from(curvature),
    speedLimit: new Array(n).fill(30),
    grip: Array.from(grip),
    margin,
  };
}

function probeCurvature(
  px: Float64Array, py: Float64Array, n: number, i: number, dx: number, dy: number,
): number {
  const a = (i - 1 + n) % n;
  const b = (i + 1) % n;
  const ax = px[i] + dx - px[a];
  const ay = py[i] + dy - py[a];
  const bx = px[b] - px[i] - dx;
  const by = py[b] - py[i] - dy;
  const cross = ax * by - ay * bx;
  const len = Math.max(1e-6, Math.hypot(ax, ay) * Math.hypot(bx, by));
  const ds = (Math.hypot(ax, ay) + Math.hypot(bx, by)) * 0.5;
  return cross / (len * ds);
}

/**
 * Fill speedLimit from the line curvature plus braking/acceleration limits.
 * latG and decel/accel are in m/s^2.
 */
export function computeSpeedProfile(
  track: Track,
  line: RacingLine,
  latG: number,
  decel: number,
  accel: number,
  topSpeed: number,
): number[] {
  const n = line.curvature.length;
  const limit = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = Math.abs(line.curvature[i]);
    const vCorner = c < 1e-5 ? topSpeed : Math.sqrt((latG * line.grip[i]) / c);
    limit[i] = Math.min(topSpeed, vCorner);
  }
  // ds between samples
  const dsOf = (i: number) => {
    const j = (i + 1) % n;
    let d = track.s[j] - track.s[i];
    if (d <= 0) d += track.totalLength;
    return Math.max(0.05, d);
  };
  // Backward pass: you cannot arrive faster than you can brake to the corner.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const i = (n - 1 - k + n) % n;
      const prev = (i + 1) % n;
      const ds = dsOf(i);
      const vNext = limit[prev];
      limit[i] = Math.min(limit[i], Math.sqrt(Math.max(0, vNext * vNext + 2 * decel * ds)));
    }
    // Forward pass: you cannot accelerate faster than the car allows.
    for (let k = 0; k < n; k++) {
      const i = k;
      const prev = (i - 1 + n) % n;
      const ds = dsOf(prev);
      const vPrev = limit[prev];
      limit[i] = Math.min(limit[i], Math.sqrt(vPrev * vPrev + 2 * accel * ds));
    }
  }
  return limit;
}

/** Convert a speed profile into an approximate lap time, seconds. */
export function estimateLapTime(track: Track, speeds: number[]): number {
  const n = speeds.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ds = track.s[j] - track.s[i];
    if (ds <= 0) ds += track.totalLength;
    const v = (speeds[i] + speeds[j]) * 0.5;
    t += ds / Math.max(1, v);
  }
  return t;
}

/**
 * Physical grip budget for a given car/setup: how much lateral acceleration
 * the tyres can actually deliver at speed. Used to scale the AI so it drives
 * the car it has, not an idealised one.
 */
export function carGripBudget(
  massKg: number,
  peakMu: number,
  downforceAt100: number,
  airDensity: number,
  speed: number,
): { latAccel: number; brakeAccel: number } {
  const v2 = (speed * speed) / (27.7778 * 27.7778);
  const df = downforceAt100 * v2 * (airDensity / 1.225);
  const fz = massKg * G + df;
  const latAccel = (peakMu * fz) / massKg;
  return { latAccel, brakeAccel: latAccel * 0.92 };
}

/** Smooth an array in place (circular). */
export function circularSmooth(values: number[], passes = 2, strength = 0.5): number[] {
  let a = values.slice();
  for (let p = 0; p < passes; p++) {
    const b = a.slice();
    const n = a.length;
    for (let i = 0; i < n; i++) {
      const prev = a[(i - 1 + n) % n];
      const next = a[(i + 1) % n];
      b[i] = a[i] + (prev + next - 2 * a[i]) * strength;
    }
    a = b;
  }
  return a;
}
