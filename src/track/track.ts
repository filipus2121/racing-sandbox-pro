import { TAU, clamp, normalizeAngle } from '../core/math.js';
import { NEUTRAL_SURFACE, SurfaceSample } from '../physics/vehicle.js';

export const SURFACE_TARMAC = 0;
export const SURFACE_RUMBLE = 1; // kerb / rumble strip
export const SURFACE_GRASS = 2;
export const SURFACE_GRAVEL = 3;
export const SURFACE_CONCRETE = 4; // pit lane / apron

export interface SurfaceProps {
  grip: number;
  rollingResist: number;
  /** How quickly standing water drains from this surface. */
  drainage: number;
  label: string;
  color: string;
}

export const SURFACES: Record<number, SurfaceProps> = {
  [SURFACE_TARMAC]: { grip: 1, rollingResist: 0, drainage: 1, label: 'Tarmac', color: '#3b3f46' },
  [SURFACE_RUMBLE]: { grip: 0.94, rollingResist: 0.006, drainage: 1.4, label: 'Rumble', color: '#c8452f' },
  [SURFACE_GRASS]: { grip: 0.42, rollingResist: 0.09, drainage: 2.2, label: 'Grass', color: '#3f6b3a' },
  [SURFACE_GRAVEL]: { grip: 0.55, rollingResist: 0.16, drainage: 3.5, label: 'Gravel', color: '#8a7b5c' },
  [SURFACE_CONCRETE]: { grip: 0.85, rollingResist: 0.01, drainage: 1.2, label: 'Concrete', color: '#6b6f76' },
};

export interface PointQuery {
  /** Distance along the centreline, m. */
  s: number;
  /** Signed lateral offset, m (positive = left of the direction of travel). */
  lateral: number;
  /** Nearest centreline sample index. */
  index: number;
  heading: number;
  curvature: number;
  width: number;
  elevation: number;
  bank: number;
  /** True if inside the tarmac. */
  onTrack: boolean;
  /** -1 = right edge, +1 = left edge, 0 = centre. */
  relativeLateral: number;
  surface: number;
  /** Rubber laid down on the racing line, 0..1. */
  rubber: number;
  waterDepth: number;
  grip: number;
  rollingResist: number;
  /** Grade along the direction of travel, rad (>0 = uphill ahead). */
  slopeAlong: number;
  /** Cross slope in the direction of travel, rad (>0 = falls to the left). */
  slopeAcross: number;
  /** World position of the nearest centreline point. */
  cx: number;
  cy: number;
}

/** Catmull-Rom interpolation of a closed control polygon. */
export function catmullRomClosed(
  pts: { x: number; y: number }[], samplesPerSegment: number,
): { x: number; y: number }[] {
  const n = pts.length;
  if (n < 3) return pts.map(p => ({ ...p }));
  const out: { x: number; y: number }[] = [];
  const P = (i: number) => pts[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

export class Track {
  name = 'Unnamed';
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  readonly s: number[] = [];
  readonly heading: number[] = [];
  readonly curvature: number[] = [];
  readonly width: number[] = [];
  readonly height: number[] = [];
  readonly rubber: number[] = [];
  /** mm of standing water per sample. */
  readonly water: number[] = [];
  readonly surface: number[] = [];
  totalLength = 0;
  startLateral = 0;
  /** Extra material outside the normal run-off, for scenery. */
  margin = 26;

  private cell = 10;
  private grid = new Map<number, number[]>();
  private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  get length(): number {
    return this.totalLength;
  }

  /** Build from a dense centreline (already smoothed). */
  static fromPolyline(points: { x: number; y: number }[], widthM = 12): Track {
    const t = new Track();
    const n = points.length;
    if (n < 4) throw new Error('Track needs at least 4 centreline points');
    for (let i = 0; i < n; i++) {
      t.xs.push(points[i].x);
      t.ys.push(points[i].y);
      t.width.push(widthM);
      t.height.push(0);
      t.rubber.push(0);
      t.water.push(0);
      t.surface.push(SURFACE_TARMAC);
    }
    t.computeArcAndCurvature();
    t.buildGrid();
    return t;
  }

  /** Build from sparse control points using Catmull-Rom smoothing. */
  static fromControlPoints(
    control: { x: number; y: number }[], widthM = 12, samplesPerSegment = 24,
  ): Track {
    return Track.fromPolyline(catmullRomClosed(control, samplesPerSegment), widthM);
  }

  private computeArcAndCurvature(): void {
    const n = this.xs.length;
    this.s.length = 0;
    this.heading.length = 0;
    this.curvature.length = 0;
    let acc = 0;
    this.s.push(0);
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const q = (i + 1) % n;
      this.heading.push(Math.atan2(this.ys[q] - this.ys[p], this.xs[q] - this.xs[p]));
      if (i > 0) {
        acc += Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
        this.s.push(acc);
      }
    }
    acc += Math.hypot(this.xs[0] - this.xs[n - 1], this.ys[0] - this.ys[n - 1]);
    this.totalLength = acc;
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const q = (i + 1) % n;
      const ds = Math.max(1e-3, this.s[q] - this.s[p] + (q < p ? this.totalLength : 0));
      this.curvature.push(normalizeAngle(this.heading[q] - this.heading[p]) / ds);
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.xs[i]);
      minY = Math.min(minY, this.ys[i]);
      maxX = Math.max(maxX, this.xs[i]);
      maxY = Math.max(maxY, this.ys[i]);
    }
    this.bounds = { minX, minY, maxX, maxY };
  }

  private key(cx: number, cy: number): number {
    return (cx + 512) * 4096 + (cy + 512);
  }

  private buildGrid(): void {
    this.grid.clear();
    const n = this.xs.length;
    this.cell = Math.max(4, Math.min(24, (this.totalLength / n) * 3));
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((this.xs[i] - this.bounds.minX) / this.cell);
      const cy = Math.floor((this.ys[i] - this.bounds.minY) / this.cell);
      const k = this.key(cx, cy);
      const arr = this.grid.get(k);
      if (arr) arr.push(i);
      else this.grid.set(k, [i]);
    }
  }

  /** Index of the centreline sample nearest to a world point. */
  nearestIndex(x: number, y: number, hint = -1): number {
    const n = this.xs.length;
    // Cheap fast path: the caller usually knows roughly where it was last.
    if (hint >= 0) {
      let best = hint;
      let bestD = Infinity;
      const span = 6;
      for (let d = -span; d <= span; d++) {
        const i = ((hint + d) % n + n) % n;
        const dx = this.xs[i] - x;
        const dy = this.ys[i] - y;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
      if (bestD < (this.cell * 0.8) ** 2) return best;
    }
    const cx = Math.floor((x - this.bounds.minX) / this.cell);
    const cy = Math.floor((y - this.bounds.minY) / this.cell);
    let best = 0;
    let bestD = Infinity;
    for (let r = 0; r <= 4; r++) {
      for (let ox = -r; ox <= r; ox++) {
        for (let oy = -r; oy <= r; oy++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const arr = this.grid.get(this.key(cx + ox, cy + oy));
          if (!arr) continue;
          for (const i of arr) {
            const dx = this.xs[i] - x;
            const dy = this.ys[i] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Stop only once the best hit is provably closer than anything still
      // unsearched. A point in ring k can be no nearer than (k-1)*cell, so
      // after sweeping rings 0..r every remaining candidate is at least
      // r*cell away. Breaking on the first non-empty ring instead returns a
      // farther sample whenever a neighbour cell holds a closer one.
      if (bestD < (r * this.cell) ** 2) break;
    }
    return best;
  }

  /** Full track query at a world position. */
  query(x: number, y: number, hint = -1): PointQuery {
    const n = this.xs.length;
    const i = this.nearestIndex(x, y, hint);
    const h = this.heading[i];
    const nx = -Math.sin(h);
    const ny = Math.cos(h);
    const dx = x - this.xs[i];
    const dy = y - this.ys[i];
    const lateral = dx * nx + dy * ny;
    // Arc position by projecting onto the better of the two adjacent segments,
    // rather than snapping to the nearest sample. Snapping quantises s to the
    // sample spacing (about 2.6 m here, so up to 1.3 m of error), which is
    // coarse enough to disturb sector timing; a tangent offset alone does not
    // fix it either, because a point offset purely sideways has no tangent
    // component at all.
    let sAt = this.s[i];
    {
      const project = (a: number, b: number) => {
        const ex = this.xs[b] - this.xs[a];
        const ey = this.ys[b] - this.ys[a];
        const len2 = ex * ex + ey * ey;
        if (len2 < 1e-9) return null;
        const t = clamp(((x - this.xs[a]) * ex + (y - this.ys[a]) * ey) / len2, 0, 1);
        const px = this.xs[a] + ex * t;
        const py = this.ys[a] + ey * t;
        let sb = this.s[b];
        if (sb < this.s[a]) sb += this.totalLength;
        return {
          d2: (x - px) * (x - px) + (y - py) * (y - py),
          s: this.s[a] + (sb - this.s[a]) * t,
        };
      };
      const cands = [project((i - 1 + n) % n, i), project(i, (i + 1) % n)];
      let bestD = Infinity;
      for (const c of cands) {
        if (c && c.d2 < bestD) {
          bestD = c.d2;
          sAt = ((c.s % this.totalLength) + this.totalLength) % this.totalLength;
        }
      }
    }
    const half = this.width[i] * 0.5;
    const absL = Math.abs(lateral);
    const rel = half > 0 ? clamp(lateral / half, -4, 4) : 0;

    // Surface bands: tarmac -> rumble strip -> whatever the run-off is.
    let surface = this.surface[i];
    if (absL > half) {
      const over = absL - half;
      if (over < 1.4) {
        surface = SURFACE_RUMBLE;
      } else if (this.surface[i] === SURFACE_TARMAC) {
        // Unpainted run-off is grass. Leaving it as tarmac meant driving off
        // the track kept full asphalt grip, so there was no penalty at all for
        // leaving the racing surface.
        surface = SURFACE_GRASS;
      }
    }
    // A painted surface is honoured wherever it was painted. Forcing tarmac
    // back on inside the track edges made the editor brush a no-op on the
    // racing surface itself, so painting grass or gravel there did nothing.
    const props = SURFACES[surface] ?? SURFACES[SURFACE_GRASS];

    // Rubber laid on the racing line adds grip right in the groove.
    const rubber = this.rubber[i];
    const onLine = absL < half * 0.45;
    const rubberGrip = onLine ? 1 + rubber * 0.09 : 1 - rubber * 0.02;

    // Elevation, grade and banking from the height field.
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const dsT = Math.max(1e-3, this.s[next] - this.s[prev] + (next < prev ? this.totalLength : 0));
    const dHds = (this.height[next] - this.height[prev]) / dsT;
    const bank = this.bankAt(i);
    // Local ground height at this exact lateral position (for scenery/AI).
    void prev; void next;

    return {
      s: sAt,
      lateral,
      index: i,
      heading: h,
      curvature: this.curvature[i],
      width: this.width[i],
      elevation: this.height[i],
      bank,
      slopeAlong: dHds,
      slopeAcross: Math.tan(bank),
      onTrack: absL <= half,
      relativeLateral: rel,
      surface,
      rubber,
      waterDepth: this.water[i],
      grip: props.grip * rubberGrip,
      rollingResist: props.rollingResist,
      cx: this.xs[i],
      cy: this.ys[i],
    };
  }

  /** Ground height at a lateral offset from the centreline of sample i. */
  heightAtLateral(i: number, lateral: number): number {
    const half = this.width[i] * 0.5;
    const inside = Math.abs(lateral) <= half ? lateral : half * Math.sign(lateral);
    const drop = Math.abs(lateral) > half
      ? -Math.pow(Math.abs(lateral) - half, 1.3) * 0.06
      : 0;
    return this.height[i] + inside * Math.tan(this.bankAt(i)) + drop;
  }

  /** Cross-slope (banking) at a sample, rad. Positive lifts the left side. */
  bankAt(i: number): number {
    const n = this.xs.length;
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const ds = Math.max(1e-3, this.s[next] - this.s[prev] + (next < prev ? this.totalLength : 0));
    // Banking follows the rate of change of curvature: real circuits bank
    // into sustained fast corners.
    const dc = (this.curvature[next] - this.curvature[prev]) / ds;
    return clamp(-dc * 55, -0.28, 0.28);
  }

  /** World position of a point at (s, lateral). */
  pointAt(s: number, lateral = 0): { x: number; y: number; heading: number; index: number } {
    const n = this.xs.length;
    const target = ((s % this.totalLength) + this.totalLength) % this.totalLength;
    // Last sample with s <= target, so the point is interpolated forward into
    // segment [i, i+1]. Searching for the first sample with s >= target makes
    // (target - s[i]) negative, which the clamp below folds to 0 -- so the
    // "interpolated" position was always exactly a sample, and the arc
    // coordinate came back quantised to the sample spacing.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.s[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % n;
    const segLen = Math.max(1e-3, this.s[j] - this.s[i] + (j < i ? this.totalLength : 0));
    const t = clamp((target - this.s[i]) / segLen, 0, 1);
    const h = this.heading[i];
    return {
      x: this.xs[i] + (this.xs[j] - this.xs[i]) * t - Math.sin(h) * lateral,
      y: this.ys[i] + (this.ys[j] - this.ys[i]) * t + Math.cos(h) * lateral,
      heading: h,
      index: i,
    };
  }

  /** Start/finish line pose for grid slot `slot` (0 = pole). */
  gridPose(slot: number, rowOffset = 8): { x: number; y: number; heading: number } {
    const back = 6 + slot * rowOffset;
    const side = slot % 2 === 0 ? -this.width[0] * 0.22 : this.width[0] * 0.22;
    const p = this.pointAt(this.totalLength - back, side);
    return { x: p.x, y: p.y, heading: p.heading };
  }

  /** Fill a SurfaceSample for the vehicle from a world position. */
  fillSurface(
    x: number, y: number, out: SurfaceSample, hint = -1, carHeading = 0,
  ): PointQuery {
    const q = this.query(x, y, hint);
    out.grip = q.grip;
    out.rollingResist = q.rollingResist;
    out.waterDepth = q.waterDepth;
    out.bank = q.bank;
    // Grade in the CAR's frame, not the track's: project onto the heading.
    const dh = q.heading - carHeading;
    out.slopeAlong = q.slopeAlong * Math.cos(dh);
    out.slopeAcross = q.slopeAcross * Math.cos(dh) + q.slopeAlong * Math.sin(dh);
    out.rubber = q.rubber;
    return q;
  }

  static neutralSurface(): SurfaceSample {
    return { ...NEUTRAL_SURFACE };
  }

  /** Advance the weather: rain fills puddles, dry weather evaporates them. */
  updateWeather(dt: number, rainMmH: number, evaporation = 0.0083): void {
    const n = this.xs.length;
    // rainMmH * 0.00028 is rainfall in mm per second (12 mm/h -> 0.0034 mm/s).
    const add = rainMmH * 0.00028 * dt;
    for (let i = 0; i < n; i++) {
      const drainage = (SURFACES[this.surface[i]]?.drainage ?? 1);
      // Loss must scale with the water that is actually there. The previous
      // constant term evaporated 0.0875 mm/s with an empty track -- a drying
      // rate of 315 mm/h, 26x the heaviest rain -- so water could never rise
      // above zero. Proportional loss with this coefficient gives a ~2 minute
      // time constant: a wet track reaches an equilibrium film of about
      // 0.4 mm under 12 mm/h and clears in a few minutes when the rain stops.
      const loss = evaporation * drainage * dt * this.water[i];
      this.water[i] = clamp(this.water[i] + add - loss, 0, 6);
    }
  }

  /** Lay rubber on the racing line where cars actually drive. */
  addRubber(index: number, amount: number): void {
    const n = this.xs.length;
    for (let d = -1; d <= 1; d++) {
      const i = ((index + d) % n + n) % n;
      this.rubber[i] = clamp(this.rubber[i] + amount, 0, 1);
    }
  }

  // ---- Editor brushes ----------------------------------------------------
  setWidthAt(x: number, y: number, widthM: number, radius: number): void {
    const n = this.xs.length;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
      if (d < radius) this.width[i] = clamp(widthM, 4, 60);
    }
  }

  setHeightAt(x: number, y: number, delta: number, radius: number): void {
    const n = this.xs.length;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
      if (d < radius) {
        const f = 1 - d / radius;
        this.height[i] = clamp(this.height[i] + delta * f, -40, 60);
      }
    }
  }

  setSurfaceAt(x: number, y: number, surface: number, radius: number): void {
    const n = this.xs.length;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
      if (d < radius) this.surface[i] = surface;
    }
  }

  /** Re-derive arc lengths after an edit. */
  refresh(): void {
    this.computeArcAndCurvature();
    this.buildGrid();
  }

  /** Serialise for save/load. */
  toJSON(): object {
    return {
      name: this.name,
      xs: this.xs, ys: this.ys, width: this.width,
      height: this.height, surface: this.surface,
      startLateral: this.startLateral,
    };
  }

  static fromJSON(data: {
    name?: string; xs: number[]; ys: number[]; width?: number[];
    height?: number[]; surface?: number[];
  }): Track {
    const t = new Track();
    t.name = data.name ?? 'Imported';
    const n = data.xs.length;
    for (let i = 0; i < n; i++) {
      t.xs.push(data.xs[i]);
      t.ys.push(data.ys[i]);
      t.width.push(data.width?.[i] ?? 12);
      t.height.push(data.height?.[i] ?? 0);
      t.rubber.push(0);
      t.water.push(0);
      t.surface.push(data.surface?.[i] ?? SURFACE_TARMAC);
    }
    t.refresh();
    return t;
  }

  /** Signed area, used to detect the direction of travel (CW/CCW). */
  signedArea(): number {
    const n = this.xs.length;
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += this.xs[i] * this.ys[j] - this.xs[j] * this.ys[i];
    }
    return a * 0.5;
  }

  /** Total absolute turning, ~TAU for a simple closed lap. */
  totalTurning(): number {
    const n = this.heading.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += normalizeAngle(this.heading[(i + 1) % n] - this.heading[i]);
    }
    return total;
  }

  get bounds_(): { minX: number; minY: number; maxX: number; maxY: number } {
    return this.bounds;
  }

  /** Uniform spacing check: max segment length, useful after editing. */
  maxSegmentLength(): number {
    const n = this.xs.length;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      m = Math.max(m, Math.hypot(this.xs[j] - this.xs[i], this.ys[j] - this.ys[i]));
    }
    return m;
  }

  /** Convenience for AI: radius of curvature at s (m), Infinity on straights. */
  radiusAt(s: number): number {
    const p = this.pointAt(s, 0);
    const c = this.curvature[p.index];
    return Math.abs(c) < 1e-5 ? Infinity : 1 / Math.abs(c);
  }

  /** Wrap a distance along the track. */
  wrap(s: number): number {
    return ((s % this.totalLength) + this.totalLength) % this.totalLength;
  }

  /** Angle subtended per metre; used to sanity-check a closed loop. */
  isClosedLoop(): boolean {
    return Math.abs(this.totalTurning()) > Math.PI * 1.5 &&
      Math.abs(Math.abs(this.totalTurning()) - TAU) < 0.6;
  }
}
