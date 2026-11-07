import { TRACK_PRESETS, buildPresetTrack } from '../src/track/presets.js';
import { computeRacingLine, computeSpeedProfile } from '../src/track/racingLine.js';
import { G } from '../src/core/math.js';
const track = buildPresetTrack(TRACK_PRESETS[0]);
const line = computeRacingLine(track, { carHalfWidth: 1.0, margin: 0.8 });
// Same latG World now uses after the measured calibration (1.02 g).
const latG = 1.02;
const lim = computeSpeedProfile(track, line, latG * G, latG * G * 0.9, latG * G * 0.32, 105);
const n = lim.length;
let mn = Infinity, mx = 0, sum = 0;
for (let i = 0; i < n; i++) { mn = Math.min(mn, lim[i]); mx = Math.max(mx, lim[i]); sum += lim[i]; }
console.log('speedLimit: min', mn.toFixed(1), 'm/s =', (mn*3.6).toFixed(0), 'km/h | max', mx.toFixed(1),
  '=', (mx*3.6).toFixed(0), 'km/h | mean', (sum/n*3.6).toFixed(0), 'km/h');
// Where are the slowest points, and does the curvature agree?
const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lim[a] - lim[b]);
console.log('\nslowest 8 samples (s, speedLimit, |curvature|, implied radius):');
for (const i of order.slice(0, 8)) {
  const c = Math.abs(line.curvature[i]);
  console.log('  s', track.s[i].toFixed(0).padStart(4),
    'v', (lim[i]*3.6).toFixed(0).padStart(3), 'km/h',
    '|k|', c.toFixed(4),
    'R', c > 1e-6 ? (1/c).toFixed(0) : 'inf',
    'v^2/R g', c > 1e-6 ? ((lim[i]*lim[i]*c)/G).toFixed(2) : '-');
}
console.log('\nfastest 4:');
for (const i of order.slice(-4)) {
  console.log('  s', track.s[i].toFixed(0).padStart(4), 'v', (lim[i]*3.6).toFixed(0), 'km/h',
    '|k|', Math.abs(line.curvature[i]).toFixed(4));
}
