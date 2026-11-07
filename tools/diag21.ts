import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
const preset = TRACK_PRESETS[0];
const w = new World({
  track: buildPresetTrack(preset), playerSpec: GT3_VENOM, playerSetup: defaultSetup(GT3_VENOM),
  aiSpecs: Object.values(CAR_SPECS), aiCount: 5, laps: 5,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 2024,
} as WorldConfig);
const playerIn = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
for (let i = 0; i < 500 * 180; i++) w.update(1 / 500, playerIn);   // 3 minutes
console.log('track', w.track.totalLength.toFixed(0), 'm | after 180 s');
for (const r of w.racers) {
  if (r.isPlayer) continue;
  console.log(r.name.padEnd(14), 'laps', r.lap,
    'best', r.bestLap ? (r.bestLap / 1000).toFixed(2) + 's' : '--',
    'last', r.lastLap ? (r.lastLap / 1000).toFixed(2) + 's' : '--',
    'prog', r.progressDistance.toFixed(0).padStart(5),
    'off', r.offTrack ? 'Y' : 'n',
    'kmh', (r.car.speed * 3.6).toFixed(0).padStart(3),
    'gear', r.car.gear);
}
