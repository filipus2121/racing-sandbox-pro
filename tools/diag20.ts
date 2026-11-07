import { World, WorldConfig } from '../src/state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { CAR_SPECS, defaultSetup, GT3_VENOM } from '../src/physics/cars.js';
import { CarInput, NO_INPUT } from '../src/physics/vehicle.js';
const preset = TRACK_PRESETS[0];
const w = new World({
  track: buildPresetTrack(preset), playerSpec: GT3_VENOM, playerSetup: defaultSetup(GT3_VENOM),
  aiSpecs: Object.values(CAR_SPECS), aiCount: 1, laps: 3,
  env: { airTempC: 24, trackTempC: 32, airDensity: 1.225, rainMmH: 0, baseGrip: 1, windX: 0, windY: 0 },
  seed: 7,
} as WorldConfig);
const ai = w.racers.find(r => !r.isPlayer)!;
const probe: CarInput = { ...NO_INPUT };
const playerIn: CarInput = { ...NO_INPUT };
console.log('gearCount', ai.car.gearCount(), 'ratios', ai.car.setup.gearRatios.join(','),
  'redline', ai.car.spec.engine.redlineRpm, 'upshiftTime', ai.car.spec.engine.upshiftTime);
for (let i = 0; i < 500 * 20; i++) {
  // Ask the opponent directly what it wants, mirroring what World does.
  ai.opponent!.update(ai.car, w.track, w.line, w.speedLimit, 1 / 500, [],
    w.aiLimits[1] ?? w.aiLimits[0], probe);
  w.update(1 / 500, playerIn);
  if (i % 2500 === 0) {
    console.log('t', (i / 500).toFixed(0).padStart(2),
      'kmh', (ai.car.speed * 3.6).toFixed(0).padStart(3),
      'rpm', Math.round(ai.car.rpm).toString().padStart(5),
      'gear', ai.car.gear,
      'shiftTimer', ai.car.shiftTimer.toFixed(3),
      'wantUp', probe.shiftUp ? 'Y' : 'n',
      'thr', probe.throttle.toFixed(2),
      'steer', probe.steer.toFixed(2));
  }
}
