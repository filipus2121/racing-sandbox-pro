export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G = 9.80665;
export const AIR_DENSITY = 1.225; // kg/m^3 at sea level, 15C

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** exp() that never overflows to Infinity (used in thermal models). */
export const exp = (x: number): number => Math.exp(clamp(x, -40, 40));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  b === a ? 0 : (v - a) / (b - a);

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function normalizeAngle(a: number): number {
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Deterministic, fast PRNG so replays and AI are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 1337) {
    this.s = seed >>> 0 || 1;
  }
  /** Uniform in [0,1). */
  next(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  /** Normal-ish via sum of uniforms (cheap, good enough for driver noise). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  fork(salt: number): Rng {
    return new Rng((this.s ^ (salt * 2654435761)) >>> 0);
  }
}

export function formatLap(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}

export function formatGap(ms: number): string {
  if (!isFinite(ms)) return '--';
  if (Math.abs(ms) >= 60000) return formatLap(Math.abs(ms));
  return `${(ms / 1000).toFixed(3)}s`;
}
