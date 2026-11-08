import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { computeRacingLine } from '../src/track/racingLine.js';
const preset = TRACK_PRESETS.find(p => p.id === 'daytona')!;
const t = buildPresetTrack(preset);
const line = computeRacingLine(t, { carHalfWidth: 1.0, margin: 0.8, band: preset.band });
const sorted = line.grip.map((g, i) => ({ g, i })).sort((a, b) => a.g - b.g).slice(0, 6);
for (const e of sorted) {
  const i = e.i;
  const h = t.heading[i];
  const x = t.xs[i] - Math.sin(h) * line.lateral[i];
  const y = t.ys[i] + Math.cos(h) * line.lateral[i];
  const q = t.query(x, y);
  console.log(`i ${i} s ${t.s[i].toFixed(1)} gripLine ${e.g.toFixed(3)} qgrip ${q.grip.toFixed(3)} ` +
    `curv ${t.curvature[i].toFixed(6)} bank ${(t.bankAt(i) * 180 / Math.PI).toFixed(1)} onTrack ${q.onTrack} surf ${q.surface} lat ${line.lateral[i].toFixed(2)}`);
}
const neg = t.curvature.filter(c => c < -1e-6).length;
console.log(`samples with negative curvature: ${neg} of ${t.xs.length}`);
const zero = t.curvature.filter(c => Math.abs(c) < 1e-9).length;
console.log(`samples with ~zero curvature: ${zero}`);
