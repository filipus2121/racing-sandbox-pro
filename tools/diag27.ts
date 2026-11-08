/**
 * diag27 - Daytona oval, full field, end to end.
 *
 * Runs a NASCAR Next Gen race on the tri-oval and reports the things that
 * decide whether an oval sim works at all: pack speed and drafting, lap times
 * against the speed profile, wrecks and cautions, the pace car protocol, the
 * restart order, and pit stops.
 */
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { NASCAR_NEXTGEN, defaultSetup } from '../src/physics/cars.js';
import { World, PHYS_DT } from '../src/state/world.js';
import { NO_INPUT } from '../src/physics/vehicle.js';
import { Opponent, makeDrivers } from '../src/ai/opponent.js';
import { Rng } from '../src/core/math.js';

const CARS = parseInt(process.argv[2] ?? '14', 10);
const LAPS = parseInt(process.argv[3] ?? '6', 10);

const preset = TRACK_PRESETS.find(p => p.id === 'daytona')!;
const track = buildPresetTrack(preset);
const world = new World({
  track,
  playerSpec: NASCAR_NEXTGEN,
  playerSetup: defaultSetup(NASCAR_NEXTGEN),
  aiSpecs: [NASCAR_NEXTGEN],
  aiCount: CARS - 1,
  laps: LAPS,
  env: {
    trackTempC: 38, airTempC: 26, airDensity: 1.225,
    rainMmH: 0, baseGrip: 1, windX: 0, windY: 0,
  },
  seed: 20260,
  walled: true,
  pitDef: preset.pit,
  raceControl: { paceCarLaps: 3, maxOvertimeAttempts: 3 },
  aiLatG: undefined,
});

// Put the player's car under AI control so the whole field is driving.
const drivers = makeDrivers(1, new Rng(7));
world.player.opponent = new Opponent(drivers[0], 4242);
world.player.crashThreshold = 1.0;

console.log(`Daytona Oval  ${track.totalLength.toFixed(1)} m  ${CARS} Next Gen cars, ${LAPS} laps`);
console.log(`AI speed profile: min ${(Math.min(...world.speedLimit) * 3.6).toFixed(0)} km/h  ` +
  `max ${(Math.max(...world.speedLimit) * 3.6).toFixed(0)} km/h  ` +
  `mean ${(world.speedLimit.reduce((a, b) => a + b, 0) / world.speedLimit.length * 3.6).toFixed(0)} km/h`);
console.log(`banking in the turns: ${(track.bankAt(track.pointAt(900).index) * 180 / Math.PI).toFixed(1)} deg\n`);

let maxSpeed = 0;
let minSpeed = Infinity;
let sumSpeed = 0;
let n = 0;
let maxDraft = 0;
let offTrackSteps = 0;
let totalSteps = 0;
let lastReport = -1;
let lastLeaderLap = -1;

const targetLap = world.speedLimit.length
  ? track.totalLength / (world.speedLimit.reduce((a, b) => a + b, 0) / world.speedLimit.length)
  : 60;
console.log(`profile lap time ~${targetLap.toFixed(1)} s\n`);
console.log('   t(s)  flag    ph      leadLap  leader km/h  P1 gap   pit  wreck  cautions');

const steps = Math.round(LAPS * 70 / PHYS_DT);
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  world.update(PHYS_DT, { ...NO_INPUT });
  totalSteps++;
  const rows = world.standings();
  const leader = rows[0]?.racer;
  if (leader && !leader.wrecked) {
    maxSpeed = Math.max(maxSpeed, leader.car.speed);
    minSpeed = Math.min(minSpeed, leader.car.speed);
  }
  for (const r of world.racers) {
    sumSpeed += r.car.speed;
    n++;
    if (r.offTrack) offTrackSteps++;
  }
  maxDraft = Math.max(maxDraft, ...world.draftMod.map(m => 1 - m));

  if (world.time - lastReport >= 5) {
    lastReport = world.time;
    const rowsNow = world.standings();
    const lead = rowsNow[0];
    const second = rowsNow[1];
    console.log(
      `${world.time.toFixed(0).padStart(6)}  ${world.rc.flag.padEnd(7)} ${world.rc.phase.padEnd(7)}` +
      ` ${String(lead?.laps ?? 0).padStart(5)}  ` +
      `${((lead?.racer.car.speed ?? 0) * 3.6).toFixed(0).padStart(9)} km/h  ` +
      `${(((lead?.progress ?? 0) - (second?.progress ?? 0))).toFixed(1).padStart(7)}m  ` +
      `${world.racers.filter(r => r.pit.phase !== 'none').length.toString().padStart(4)}  ` +
      `${world.racers.filter(r => r.wrecked).length.toString().padStart(5)}  ` +
      `${world.rc.cautions.length.toString().padStart(5)}`,
    );
    const pc = world.paceCar;
    if (pc) {
      console.log(`        pace: ${(pc.car.speed * 3.6).toFixed(0)} km/h gear ${pc.car.gear} ` +
        `rpm ${pc.car.rpm.toFixed(0)} thr ${pc.car.throttleActual.toFixed(2)} ` +
        `s ${pc.trackS.toFixed(0)} lat ${world.track.query(pc.car.x, pc.car.y, pc.lastIndex).lateral.toFixed(1)} ` +
        `prog ${world.rc.paceLapProgress.toFixed(2)} laps ${world.rc.paceLaps} onTrack ${world.paceCarOnTrack}`);
    }
  }
  if (world.rc.leaderLaps !== lastLeaderLap) {
    if (lastLeaderLap >= 0) {
      const lead = world.standings()[0].racer;
      console.log(`        -> lap ${lastLeaderLap} in ${lead.lastLap / 1000} s ` +
        `(${(track.totalLength / (lead.lastLap / 1000) * 3.6).toFixed(1)} km/h avg)`);
    }
    lastLeaderLap = world.rc.leaderLaps;
  }
  if (world.finished) break;
}

const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n--- summary (${wall}s wall for ${world.time.toFixed(0)}s of sim, ` +
  `${(world.time / (Date.now() - t0) * 1000).toFixed(1)}x realtime) ---`);
console.log(`leader speed      min ${(minSpeed * 3.6).toFixed(0)}  max ${(maxSpeed * 3.6).toFixed(0)} km/h`);
console.log(`field mean speed  ${(sumSpeed / Math.max(1, n) * 3.6).toFixed(1)} km/h`);
console.log(`best draft        -${(maxDraft * 100).toFixed(1)}% drag`);
console.log(`off-track         ${(offTrackSteps / Math.max(1, totalSteps) / world.racers.length * 100).toFixed(2)}% of car-steps`);
console.log(`cautions          ${world.rc.cautions.length}`);
for (const c of world.rc.cautions) {
  console.log(`   t=${c.at.toFixed(1)}s lap ${c.lap}  ${c.reason}${c.overtime ? '  [OVERTIME]' : ''}`);
}
console.log(`wrecks            ${world.racers.filter(r => r.wrecked).length}`);
console.log(`contacts >900 Ns: ${world.contactCount}, peak impulse ${world.maxContactImpulse.toFixed(0)} Ns`);
console.log('wreck timeline:');
for (const w of world.wreckLog) {
  console.log(`  t=${w.t.toFixed(1)}s  ${w.name.padEnd(16)} ${w.kmh.toFixed(0).padStart(3)} km/h  ` +
    `lat ${w.lateral.toFixed(1).padStart(6)}  dmg ${w.damage.toFixed(2)}  ${w.reason}`);
}
for (const r of world.racers.filter(r => r.wrecked)) {
  console.log(`   ${r.name}  damage ${r.damage.toFixed(2)}  retired ${r.retired}`);
}
console.log(`pit stops         ${world.racers.reduce((a, r) => a + r.pit.count, 0)}`);
for (const r of world.racers.filter(r => r.pit.count > 0)) {
  console.log(`   ${r.name}: ${r.pit.count} stop(s), fuel ${r.car.fuelL.toFixed(1)}L`);
}
console.log(`laps scheduled    ${world.rc.lapsScheduled} (overtime attempts ${world.rc.overtimeAttempts})`);
const rows = world.standings();
console.log(`\nfinal order:`);
rows.slice(0, 8).forEach((row, i) => {
  console.log(`  P${i + 1} ${row.racer.name.padEnd(14)} laps ${row.laps}  ` +
    `best ${row.bestLap ? (row.bestLap / 1000).toFixed(2) + 's' : '--'}  ` +
    `dmg ${row.damage.toFixed(2)}${row.retired ? '  RETIRED' : ''}${row.inPit ? '  PIT' : ''}`);
});
console.log(`NaN check: ${world.racers.every(r => Number.isFinite(r.car.x) && Number.isFinite(r.car.y)) ? 'clean' : 'NaN FOUND'}`);
