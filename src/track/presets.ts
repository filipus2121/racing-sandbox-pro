import { Track } from './track.js';

export interface TrackPreset {
  id: string;
  name: string;
  country: string;
  lengthLabel: string;
  /** Sparse control points, metres, closed loop. */
  control: { x: number; y: number }[];
  width: number;
  description: string;
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

export const TRACK_PRESETS: TrackPreset[] = [
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
  const t = Track.fromControlPoints(preset.control, preset.width, 30);
  t.name = preset.name;
  // Give the oval its banking explicitly via the height field curvature model:
  // Track.bankAt derives banking from the rate of change of curvature, which
  // is strongest where the oval tightens into the corners.
  return t;
}
