import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
const w = new World({
  track: buildPresetTrack(TRACK_PRESETS[0]), playerSpec: GT3_VENOM,
  playerSetup: defaultSetup(GT3_VENOM), aiSpecs: Object.values(CAR_SPECS),
  aiCount: 1, laps: 3,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 2024,
} as WorldConfig);
const ai = w.racers.find(r => !r.isPlayer)!;
const pin = { throttle: 0, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
// NO extra opponent.update() call here -- only w.update drives the bot.
let maxGear = 0;
for (let i = 0; i < 500 * 30; i++) {
  w.update(1 / 500, pin);
  maxGear = Math.max(maxGear, ai.car.gear);
  if (i % 2500 === 0) {
    console.log('t', (i / 500).toFixed(1).padStart(4),
      'kmh', (ai.car.speed * 3.6).toFixed(0).padStart(3),
      'rpm', Math.round(ai.car.rpm).toString().padStart(5),
      'gear', ai.car.gear,
      'lat', w.track.query(ai.car.x, ai.car.y, ai.lastIndex).lateral.toFixed(1).padStart(7),
      'onTrk', ai.offTrack ? 'n' : 'Y');
  }
}
console.log('max gear reached over 30 s:', maxGear, 'of', ai.car.gearCount());
