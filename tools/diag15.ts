import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';

const preset = TRACK_PRESETS[0];
const spec = GT3_VENOM;
const config: WorldConfig = {
  track: buildPresetTrack(preset),
  playerSpec: spec,
  playerSetup: defaultSetup(spec),
  aiSpecs: Object.values(CAR_SPECS),
  aiCount: 7,
  laps: 2,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 12345,
};
const w = new World(config);
console.log('track', preset.name, 'samples', w.track.xs.length, 'length',
  w.track.totalLength.toFixed(0), 'm | racers', w.racers.length,
  '| line pts', w.line.lateral.length, '| speedLimit pts', w.speedLimit.length);

const input = { throttle: 0.6, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
let nan = 0, maxSpeed = 0;
const t0 = Date.now();
for (let i = 0; i < 500 * 60; i++) {          // 60 s at 500 Hz
  w.update(1 / 500, input);
  for (const r of w.racers) {
    if (!Number.isFinite(r.car.x) || !Number.isFinite(r.car.y) || !Number.isFinite(r.car.speed)) nan++;
    maxSpeed = Math.max(maxSpeed, r.car.speed);
  }
}
console.log('ran 60 s of sim in', ((Date.now() - t0) / 1000).toFixed(1), 's wall',
  '| NaN events', nan, '| max speed', (maxSpeed * 3.6).toFixed(0), 'km/h');
const rows = w.standings();
console.log('standings:', rows.slice(0, 4).map(r =>
  `${r.position}.${r.racer.name} lap${r.laps} best ${r.bestLap ? (r.bestLap/1000).toFixed(2) : '--'}`).join('  '));
console.log('messages:', w.messages.length, '| finished', w.finished, '| player progress',
  w.player.progressDistance.toFixed(0), 'm');
