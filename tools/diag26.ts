/**
 * diag26 - Daytona oval geometry audit.
 *
 * Confirms the tri-oval is the length it claims to be, that the explicit
 * banking actually lands at 31/18/3 degrees where it should, and prints the
 * corner speed each section supports so the AI speed profile can be checked
 * against it later.
 */
import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { computeRacingLine } from '../src/track/racingLine.js';

const preset = TRACK_PRESETS.find(p => p.id === 'daytona')!;
const t = buildPresetTrack(preset);
const DEG = 180 / Math.PI;

console.log(`samples        ${t.xs.length}`);
console.log(`total length   ${t.totalLength.toFixed(1)} m = ${(t.totalLength / 1609.344).toFixed(3)} mi`);
console.log(`closed loop    ${t.isClosedLoop()}`);

// Close: the last sample must sit within one spacing of the first.
const gap = Math.hypot(t.xs[0] - t.xs[t.xs.length - 1], t.ys[0] - t.ys[t.ys.length - 1]);
console.log(`closing gap    ${gap.toFixed(2)} m (should be ~one sample spacing)`);

// Bank and curvature sampled around the lap.
console.log('\n  s(m)   curv 1/m     R(m)   bank deg   section');
const seen = new Set<string>();
for (let s = 0; s < t.totalLength; s += 200) {
  const p = t.pointAt(s);
  const i = p.index;
  const k = t.curvature[i];
  const bank = t.bankAt(i) * DEG;
  const R = Math.abs(k) > 1e-6 ? 1 / Math.abs(k) : Infinity;
  const label = Math.abs(k) > 0.0022 ? 'TURN'
    : Math.abs(k) > 0.00055 ? 'tri-oval' : 'straight';
  const key = label + Math.round(bank);
  console.log(`${s.toString().padStart(6)}  ${k.toFixed(5).padStart(9)}  ` +
    `${(isFinite(R) ? R.toFixed(0) : 'inf').padStart(7)}  ${bank.toFixed(1).padStart(8)}   ${label}`);
  seen.add(key);
}
console.log(`\ndistinct (section, bank) pairs: ${seen.size} -> ${[...seen].join(', ')}`);

// Racing line + usable band.
const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8, band: preset.band });
console.log(`\nracing line lateral   min ${Math.min(...line.lateral).toFixed(2)} ` +
  `max ${Math.max(...line.lateral).toFixed(2)} m (band ${preset.band!.min}..${preset.band!.max})`);
console.log(`line grip             min ${Math.min(...line.grip).toFixed(2)} ` +
  `max ${Math.max(...line.grip).toFixed(2)}`);

// What the banking buys, per section, at 1.0 g of mechanical grip.
const mu = 1.0 * 9.81;
console.log('\nsection summary (measured, not nominal):');
const bySection = new Map<string, { n: number; k: number; bank: number; s0: number }>();
for (let i = 0; i < t.xs.length; i++) {
  const k = Math.abs(t.curvature[i]);
  const name = k > 0.0022 ? 'turn' : k > 0.0004 ? 'tri-oval' : 'straight';
  const e = bySection.get(name) ?? { n: 0, k: 0, bank: 0, s0: t.s[i] };
  e.n++; e.k += k; e.bank += t.bankAt(i) * DEG;
  bySection.set(name, e);
}
for (const [name, e] of bySection) {
  const k = e.k / e.n;
  const bank = e.bank / e.n;
  const len = e.n * (t.totalLength / t.xs.length);
  const vFlat = k > 1e-6 ? Math.sqrt(mu / k) : Infinity;
  const vBank = k > 1e-6 ? Math.sqrt(mu * (1 + Math.tan(bank * Math.PI / 180)) / k) : Infinity;
  console.log(`  ${name.padEnd(9)} ${len.toFixed(0).padStart(5)} m  R ${k > 1e-6 ? (1 / k).toFixed(0) : 'inf'} m  ` +
    `bank ${bank.toFixed(1)} deg  flat ${vFlat === Infinity ? 'inf' : (vFlat * 3.6).toFixed(0)} km/h  ` +
    `banked ${vBank === Infinity ? 'inf' : (vBank * 3.6).toFixed(0)} km/h`);
}
const worst = t.curvature.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c)[0];
console.log(`\nmost negative curvature ${worst.c.toFixed(6)} at i=${worst.i} s=${t.s[worst.i].toFixed(0)} ` +
  `(a tangent-continuous oval should have none below ~0)`);

// Pit lane must sit inside the surface and outside the racing band.
const pit = preset.pit!;
console.log(`\npit lane  s ${pit.entryS}..${pit.exitS} m, ` +
  `lateral ${pit.bandFrom}..${pit.bandTo} m, ${pit.boxes} boxes`);
console.log(`track width at pit entry ${(t.width[t.pointAt(pit.entryS).index] * 0.5).toFixed(2)} m half`);
console.log(`pit lane inside the surface: ${pit.bandTo <= t.width[0] * 0.5 + 0.001}`);
console.log(`racing band excludes pit:    ${preset.band!.max <= pit.bandFrom + 0.001}`);
const frontRightLen = t.pointAt(pit.exitS).index;
console.log(`pit exit index ${frontRightLen} of ${t.xs.length}`);
