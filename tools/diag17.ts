import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
const preset = TRACK_PRESETS[0];
const w = new World({
  track: buildPresetTrack(preset), playerSpec: GT3_VENOM, playerSetup: defaultSetup(GT3_VENOM),
  aiSpecs: Object.values(CAR_SPECS), aiCount: 2, laps: 3,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 7,
} as WorldConfig);
const input = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
const ai = w.racers.find(r => !r.isPlayer)!;
const p0 = w.track.query(ai.car.x, ai.car.y);
console.log('grid: car at', ai.car.x.toFixed(1), ai.car.y.toFixed(1), 'hdg', ai.car.heading.toFixed(3),
  '| nearest centreline idx', p0.index, 'lateral', p0.lateral.toFixed(2),
  '| halfWidth', (w.track.width[p0.index] / 2).toFixed(2),
  '| countdown', w.countdown.toFixed(1));
for (let i = 0; i < 500 * 20; i++) {
  w.update(1 / 500, input);
  if (i % 2500 === 0) {
    const q = w.track.query(ai.car.x, ai.car.y);
    const d = ai.opponent!.debug;
    console.log('t', (i / 500).toFixed(0).padStart(2),
      'kmh', (ai.car.speed * 3.6).toFixed(0).padStart(3), 'gear', ai.car.gear,
      'lat', q.lateral.toFixed(1).padStart(6), 'off', ai.offTrack ? 'Y' : 'n',
      'thr', (d as unknown as { throttle?: number }).throttle?.toFixed?.(2) ?? '-',
      'tgt', d.targetSpeed.toFixed(0).padStart(3), 'note', d.note);
  }
}
