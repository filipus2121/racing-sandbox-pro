import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
import { CarInput, NO_INPUT } from '../src/physics/vehicle.js';
const w = new World({
  track: buildPresetTrack(TRACK_PRESETS[0]), playerSpec: GT3_VENOM,
  playerSetup: defaultSetup(GT3_VENOM), aiSpecs: Object.values(CAR_SPECS),
  aiCount: 1, laps: 3,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 2024,
} as WorldConfig);
const ai = w.racers.find(r => !r.isPlayer)!;
const probe: CarInput = { ...NO_INPUT };
const pin: CarInput = { ...NO_INPUT };
for (let i = 0; i < 500 * 60; i++) {
  ai.opponent!.update(ai.car, w.track, w.line, w.speedLimit, 1 / 500, [],
    w.aiLimits[1] ?? w.aiLimits[0], probe);
  w.update(1 / 500, pin);
  if (i % 5000 === 0) {
    const q = w.track.query(ai.car.x, ai.car.y, ai.lastIndex);
    console.log('t', (i / 500).toFixed(0).padStart(2),
      'started', w.started ? 'Y' : 'n',
      'kmh', (ai.car.speed * 3.6).toFixed(1).padStart(5),
      'gear', ai.car.gear, 'rpm', Math.round(ai.car.rpm).toString().padStart(5),
      'thr', probe.throttle.toFixed(2), 'brk', probe.brake.toFixed(2),
      'steer', probe.steer.toFixed(2),
      'lat', q.lateral.toFixed(1).padStart(6), 'onTrk', q.onTrack ? 'Y' : 'n',
      'grip', q.grip.toFixed(2), 'surf', q.surface,
      '|', ai.opponent!.debug.note);
  }
}
