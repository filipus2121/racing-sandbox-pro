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
console.log('spec', ai.car.spec.name, 'redline', ai.car.spec.engine.redlineRpm,
  'gears', ai.car.gearCount(), 'gearHold init', (ai.opponent as unknown as { gearHold: number }).gearHold);
for (let i = 0; i < 500 * 30; i++) {
  ai.opponent!.update(ai.car, w.track, w.line, w.speedLimit, 1 / 500, [],
    w.aiLimits[1] ?? w.aiLimits[0], probe);
  const wantUp = probe.shiftUp;
  const gearBefore = ai.car.gear;
  w.update(1 / 500, pin);
  if (i % 2500 === 0 || (wantUp && gearBefore === ai.car.gear)) {
    console.log('t', (i / 500).toFixed(1).padStart(4),
      'kmh', (ai.car.speed * 3.6).toFixed(0).padStart(3),
      'rpm', Math.round(ai.car.rpm).toString().padStart(5),
      'gear', ai.car.gear, '->', ai.car.gear,
      'shiftUp', wantUp ? 'Y' : 'n',
      'shiftTimer', ai.car.shiftTimer.toFixed(3),
      'gearHold', (ai.opponent as unknown as { gearHold: number }).gearHold.toFixed(3));
  }
}
