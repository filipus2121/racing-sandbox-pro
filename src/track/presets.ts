import { Track } from './track.js';

/** Pit road, as a strip of the track surface on the inside of the front straight. */
export interface PitLaneDef {
  /** Arc position of the pit entry, m from the start/finish line. */
  entryS: number;
  /** Arc position of the pit exit, m from the start/finish line. */
  exitS: number;
  /** Lateral band of the lane, m from the centreline. Positive = inside (left). */
  bandFrom: number;
  bandTo: number;
  /** How many pit boxes (stalls) the wall has. */
  boxes: number;
  speedLimitKmh: number;
}

export interface TrackPreset {
  id: string;
  name: string;
  country: string;
  lengthLabel: string;
  /** Sparse control points, metres, closed loop. */
  control: { x: number; y: number }[];
  width: number;
  description: string;
  /**
   * True when `control` is already a dense polyline of exact geometry and must
   * not be smoothed. Ovals are built from circular arcs: running them through
   * Catmull-Rom rounds the arcs into something that is neither the radius we
   * specified nor constant, which then shows up as a phantom braking point.
   */
  dense?: boolean;
  /** Superspeedway/short track: walls, packs, double-file starts. */
  oval?: boolean;
  /**
   * Explicit cross-slope per control point, rad (unsigned). Required for
   * ovals: the front straight of a tri-oval is a genuine straight with zero
   * curvature, yet it is banked 18 degrees, so no curvature-based rule can
   * ever put banking there. Signed by turn direction when applied.
   */
  denseBanking?: number[];
  /** Length of the banking transition, m (the easement spiral). */
  bankingTransitionM?: number;
  /** Racing band when the surface is not centred on the track. */
  band?: { min: number; max: number };
  pit?: PitLaneDef;
  defaultLaps?: number;
  defaultCar?: string;
}

/** Riverside GP: long straights, a hairpin and fast sweepers. */
const RIVERSIDE: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 220, y: 10 }, { x: 380, y: 40 }, { x: 470, y: 130 },
  { x: 490, y: 260 }, { x: 420, y: 350 }, { x: 300, y: 380 }, { x: 220, y: 330 },
  { x: 190, y: 250 }, { x: 120, y: 220 }, { x: 40, y: 260 }, { x: -60, y: 330 },
  { x: -170, y: 320 }, { x: -240, y: 240 }, { x: -250, y: 120 }, { x: -180, y: 30 },
  { x: -80, y: -20 },
];

/** Kite Circuit: tight and technical, low average speed, high yaw. */
const KITE: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 150, y: 0 }, { x: 250, y: 60 }, { x: 260, y: 160 },
  { x: 200, y: 230 }, { x: 240, y: 320 }, { x: 180, y: 400 }, { x: 60, y: 410 },
  { x: -20, y: 340 }, { x: -10, y: 250 }, { x: -110, y: 210 }, { x: -180, y: 120 },
  { x: -140, y: 20 }, { x: -60, y: -40 },
];

/** Nordbank Oval: high banks, three radii, drafting. */
const NORDBANK: { x: number; y: number }[] = (() => {
  const pts: { x: number; y: number }[] = [];
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    // Egg shape: a long back straight flattened on one side.
    const rx = 260 + Math.cos(t * 2) * 30;
    const ry = 170 - Math.cos(t) * 25;
    pts.push({ x: Math.cos(t) * rx, y: Math.sin(t) * ry });
  }
  return pts;
})();

/** Highland Ring: elevation-heavy, blind crests, medium speed. */
const HIGHLAND: { x: number; y: number }[] = [
  { x: 0, y: 0 }, { x: 190, y: -20 }, { x: 330, y: 40 }, { x: 360, y: 160 },
  { x: 290, y: 250 }, { x: 330, y: 360 }, { x: 250, y: 450 }, { x: 120, y: 430 },
  { x: 90, y: 320 }, { x: -30, y: 290 }, { x: -130, y: 350 }, { x: -250, y: 300 },
  { x: -290, y: 170 }, { x: -210, y: 60 }, { x: -100, y: 40 },
];

/** Per-sample geometry of a generated oval, including its cross-slope. */
export interface OvalGeometry {
  points: { x: number; y: number }[];
  /** Cross-slope magnitude per point, rad. Unsigned: signed by turn direction. */
  banking: number[];
  /** Section name per point, for diagnostics. */
  section: string[];
}

/**
 * A tri-oval built from tangent-continuous geometry.
 *
 * Layout, travelling counter-clockwise so every turn is a left-hander:
 *
 *     start/finish apex -> front straight -> turns 3-4 -> backstretch
 *       -> turns 1-2 -> front straight -> apex
 *
 * The front straight is TWO straight segments meeting at the apex, each one
 * tangent to its turn circle. Tangency is the whole point: joining an outward
 * arc to the turn circle instead leaves a corner of (90 - 2*tilt) degrees at
 * the junction, and the curvature estimator reads that as a real corner of
 * about 20 m radius right where the banking transition sits - which then
 * smears the banking profile and puts a phantom braking point in the AI's
 * speed plan at the fastest part of the lap.
 *
 * The two front straights meet at the apex with an included angle of
 * (180 - 2*phi), which is the "tri" you can see from the air. Left as a sharp
 * corner that kink is undrivable - at 250 km/h a 24 degree direction change
 * inside one 2.5 m sample reads as a corner of about 10 m radius, and the AI
 * would brake to a crawl on the start/finish line. So the apex is blended with
 * a tangent fillet of radius `apexFilletR`, which is what a real track's
 * easement spiral does: 24 degrees spread over 670 m of arc instead of over
 * one sample, i.e. 0.41 g at 250 km/h instead of a wall.
 *
 * With tilt phi the turn circles are swept through (180 - phi) degrees each
 * and every straight is tangent, so:
 *
 *   lap   = 2R(pi - phi) + L + 2(Rf*phi + halfRun/cos(phi) - Rf*tan(phi))
 *   front = 2(Rf*phi + halfRun/cos(phi) - Rf*tan(phi)),  halfRun = L/2 + R sin(phi)
 *
 * R = 330 m, L = 966.9 m, phi = 12 deg and Rf = 1200 m solve that to
 * 4023.4 m (2.500 mi) with a 1121 m front straight against Daytona's
 * published 1158 m, and a 967 m backstretch against 914 m.
 */
export function buildTriOval(cfg: {
  turnRadius: number;
  backstretch: number;
  /** Tilt of the front straight off the horizontal, deg. */
  tiltDeg: number;
  /** Radius of the fillet that blends the apex kink, m. */
  apexFilletR: number;
  bankTurnDeg: number;
  bankTriDeg: number;
  bankStraightDeg: number;
  /** Target sample spacing, m. */
  spacing?: number;
}): OvalGeometry {
  const R = cfg.turnRadius;
  const L = cfg.backstretch;
  const Rf = cfg.apexFilletR;
  const phi = cfg.tiltDeg * Math.PI / 180;
  const spacing = cfg.spacing ?? 2.5;
  const points: { x: number; y: number }[] = [];
  const banking: number[] = [];
  const section: string[] = [];
  const D = Math.PI / 180;

  const push = (x: number, y: number, bank: number, name: string) => {
    points.push({ x, y });
    banking.push(bank);
    section.push(name);
  };

  // Touch points. The front straight is tangent to circle 1 (turns 3-4, centre
  // origin) at T1 and to circle 2 (turns 1-2, centre (L,0)) at T2.
  const t1 = { x: -R * Math.sin(phi), y: R * Math.cos(phi) };
  const t2 = { x: L + R * Math.sin(phi), y: R * Math.cos(phi) };
  const halfRun = L / 2 + R * Math.sin(phi);
  const apex = { x: L / 2, y: R * Math.cos(phi) + halfRun * Math.tan(phi) };
  // Fillet centre sits on the symmetry axis, below the apex, at the distance
  // that puts both front straights exactly Rf away from it.
  const fc = { x: L / 2, y: apex.y - Rf / Math.cos(phi) };
  const ang = (a: number) => ({ x: fc.x + Math.cos(a) * Rf, y: fc.y + Math.sin(a) * Rf });
  const pR = ang(Math.PI / 2 + phi);   // where the right front straight begins
  const pL = ang(Math.PI / 2 - phi);   // where the left front straight ends

  const straight = (
    x0: number, y0: number, x1: number, y1: number, bank: number, name: string,
  ) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(2, Math.round(len / spacing));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, bank, name);
    }
  };
  const arc = (
    cx: number, cy: number, r: number, a0: number, a1: number,
    bank: number, name: string,
  ) => {
    const sweep = a1 - a0;
    const steps = Math.max(2, Math.round(Math.abs(sweep) * r / spacing));
    for (let k = 0; k < steps; k++) {
      const a = a0 + sweep * (k / steps);
      push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, bank, name);
    }
  };

  const bankTurn = cfg.bankTurnDeg * D;
  const bankTri = cfg.bankTriDeg * D;
  const bankStraight = cfg.bankStraightDeg * D;

  // s = 0 is the start/finish line, at the top of the apex fillet.
  // 1. Right half of the apex fillet: 90 deg -> (90+phi) deg.
  arc(fc.x, fc.y, Rf, Math.PI / 2, Math.PI / 2 + phi, bankTri, 'tri-oval');
  // 2. Front straight, right half: pR -> T1. Tangent at both ends.
  straight(pR.x, pR.y, t1.x, t1.y, bankTri, 'tri-oval');
  // 3. Turns 3-4: from T1 at (90+phi) deg, CCW through 180 to 270 deg.
  arc(0, 0, R, Math.PI / 2 + phi, Math.PI * 1.5, bankTurn, 'turn 3-4');
  // 4. Backstretch, (0,-R) -> (L,-R).
  straight(0, -R, L, -R, bankStraight, 'backstretch');
  // 5. Turns 1-2: from (L,-R) at -90 deg, CCW to T2 at (90-phi) deg.
  arc(L, 0, R, -Math.PI / 2, Math.PI / 2 - phi, bankTurn, 'turn 1-2');
  // 6. Front straight, left half: T2 -> pL.
  straight(t2.x, t2.y, pL.x, pL.y, bankTri, 'tri-oval');
  // 7. Left half of the apex fillet: (90-phi) deg -> 90 deg. Closes the loop.
  arc(fc.x, fc.y, Rf, Math.PI / 2 - phi, Math.PI / 2, bankTri, 'tri-oval');
  return { points, banking, section };
}

/**
 * Daytona International Speedway: 2.5 mile tri-oval, 31 degrees in the turns,
 * 18 on the front stretch, 3 on the backstretch.
 */
const DAYTONA_GEO = buildTriOval({
  turnRadius: 330,
  backstretch: 966.9,
  tiltDeg: 12,
  apexFilletR: 1200,
  bankTurnDeg: 31,
  bankTriDeg: 18,
  bankStraightDeg: 3,
  spacing: 2.5,
});

export const TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'daytona',
    name: 'Daytona Oval',
    country: 'USA',
    lengthLabel: '4.04 km (2.5 mi)',
    control: DAYTONA_GEO.points,
    width: 16.5,
    dense: true,
    denseBanking: DAYTONA_GEO.banking,
    oval: true,
    description: 'Daytona International Speedway: 2.5 mile tri-oval, 31° banking in the ' +
      'turns and 18° on the front stretch. Nothing is decided on the throttle here - ' +
      'you need a draft, a spotter and the nerve to stay three-wide into turn 1. ' +
      'Fuel window is roughly 24 laps; tyres last about 40.',
    // Inside strip is pit road, so the racing surface is not centred.
    band: { min: -8.25, max: 3.75 },
    pit: {
      // The front straight runs 583 m from the apex to turn 3, and Daytona's
      // pit road covers most of it.
      entryS: 45, exitS: 525, bandFrom: 3.75, bandTo: 8.25,
      boxes: 12, speedLimitKmh: 88,
    },
    defaultLaps: 20,
    defaultCar: 'nascar-nextgen',
  },
  {
    id: 'riverside',
    name: 'Riverside International',
    country: 'USA',
    lengthLabel: '4.3 km',
    control: RIVERSIDE,
    width: 13,
    description: 'Long straights into heavy braking zones, a hairpin and two fast sweepers. Rewards a stable rear.',
  },
  {
    id: 'kite',
    name: 'Kite Circuit',
    country: 'JPN',
    lengthLabel: '2.9 km',
    control: KITE,
    width: 11,
    description: 'Tight, low-speed and technical. Mechanical grip and traction out of slow corners decide the lap.',
  },
  {
    id: 'nordbank',
    name: 'Nordbank Speedway',
    country: 'DEU',
    lengthLabel: '3.1 km',
    control: NORDBANK,
    width: 16,
    description: 'Banked oval with three distinct radii. Slipstreaming and tyre temperature management.',
  },
  {
    id: 'highland',
    name: 'Highland Ring',
    country: 'GBR',
    lengthLabel: '3.8 km',
    control: HIGHLAND,
    width: 12,
    description: 'Rolling elevation, crests and compressions. The car gets light over the tops - brake early.',
  },
];

export function buildPresetTrack(preset: TrackPreset): Track {
  const t = preset.dense
    ? Track.fromPolyline(preset.control, preset.width)
    : Track.fromControlPoints(preset.control, preset.width, 30);
  t.name = preset.name;

  const db = preset.denseBanking;
  if (db && db.length === preset.control.length) {
    // sign(curvature): positive on a left-hand lap, which puts the high side
    // on the outside of the corner. The wrong sign here would not merely lose
    // the benefit of banking, it would actively fight the car.
    // Same deadband as the racing line: a float-noise negative on a straight
    // would otherwise flip that sample's banking to the wrong flank, and the
    // smoothing would then drag its neighbours down with it.
    const signs = t.curvature.map(c => (Math.abs(c) < 1e-6 ? 1 : Math.sign(c)));
    t.setBanking(db.map((b, i) => b * signs[i]), preset.bankingTransitionM ?? 150);
  }
  return t;
}
