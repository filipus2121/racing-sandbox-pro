import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
const preset = TRACK_PRESETS[0];
const w = new World({
  track: buildPresetTrack(preset), playerSpec: GT3_VENOM, playerSetup: defaultSetup(GT3_VENOM),
  aiSpecs: Object.values(CAR_SPECS), aiCount: 5, laps: 3,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 999,
} as WorldConfig);
const input = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
for (let i = 0; i < 500 * 90; i++) w.update(1 / 500, input);
console.log('after 90 s, track length', w.track.totalLength.toFixed(0), 'm');
for (const r of w.racers) {
  const d = r.opponent?.debug;
  console.log((r.isPlayer ? 'PLAYER' : r.name).padEnd(14),
    'prog', r.progressDistance.toFixed(0).padStart(5),
    'lap', r.lap,
    'kmh', (r.car.speed * 3.6).toFixed(0).padStart(3),
    'gear', r.car.gear,
    'off', r.offTrack ? 'Y' : 'n',
    'wrongWay', r.wrongWay ? 'Y' : 'n',
    d ? `| tgt ${d.targetSpeed.toFixed(0)} lim ${d.speedLimitAt.toFixed(0)} off ${d.lineOffset.toFixed(1)} ${d.note}` : '');
}
