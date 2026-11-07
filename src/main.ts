import { CAR_SPECS, defaultSetup } from './physics/cars.js';
import { CarSpec } from './physics/types.js';
import { World, WorldConfig, WEATHER_PRESETS } from './state/world.js';
import { TRACK_PRESETS, buildPresetTrack } from './track/presets.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { Input } from './input.js';
import { clamp } from './core/math.js';

const canvas = document.querySelector('#view') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const hud = new Hud();
const input = new Input();
input.attach(window as unknown as HTMLElement);

const menu = document.querySelector('#menu') as HTMLElement;
const startBtn = document.querySelector('#start') as HTMLButtonElement;
const fields = document.querySelector('#menu-fields') as HTMLElement;
const hudRoot = document.querySelector('#hud') as HTMLElement;

let world: World | null = null;
let paused = false;
let last = 0;

/** Build the menu controls. */
function buildMenu(): void {
  const carKeys = Object.keys(CAR_SPECS);
  const sel = (id: string, label: string, opts: { v: string; t: string }[], first = 0) => {
    const wrap = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = label;
    const s = document.createElement('select');
    s.id = id;
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.v;
      el.textContent = o.t;
      s.appendChild(el);
    }
    s.selectedIndex = first;
    wrap.append(span, s);
    fields.appendChild(wrap);
    return s;
  };

  const trackSel = sel('track', 'Track', TRACK_PRESETS.map(p => ({
    v: p.id,
    t: `${p.name} — ${p.lengthLabel}`,
  })));
  const desc = document.createElement('p');
  desc.id = 'track-desc';
  fields.appendChild(desc);
  const syncDesc = () => {
    const p = TRACK_PRESETS.find(x => x.id === trackSel.value);
    desc.textContent = p ? p.description : '';
  };
  trackSel.addEventListener('change', syncDesc);
  syncDesc();

  sel('car', 'Car', carKeys.map(k => ({ v: k, t: CAR_SPECS[k].name })));
  sel('weather', 'Weather', WEATHER_PRESETS.map(w => ({ v: w.id, t: w.label })));

  const num = (id: string, label: string, value: number, min: number, max: number) => {
    const wrap = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = label;
    const i = document.createElement('input');
    i.type = 'number';
    i.id = id;
    i.value = String(value);
    i.min = String(min);
    i.max = String(max);
    wrap.append(span, i);
    fields.appendChild(wrap);
    return i;
  };
  const lapsEl = num('laps', 'Laps', 5, 1, 100);
  const aiEl = num('ai', 'Opponents', 9, 0, 24);

  startBtn.addEventListener('click', () => {
    const preset = TRACK_PRESETS.find(p => p.id === trackSel.value) ?? TRACK_PRESETS[0];
    const carKey = (document.querySelector('#car') as HTMLSelectElement).value;
    const spec = CAR_SPECS[carKey];
    const weather = WEATHER_PRESETS.find(w =>
      w.id === (document.querySelector('#weather') as HTMLSelectElement).value);
    startSession({
      track: buildPresetTrack(preset),
      playerSpec: spec,
      playerSetup: defaultSetup(spec),
      aiSpecs: Object.values(CAR_SPECS),
      aiCount: clamp(parseInt(aiEl.value, 10) || 0, 0, 24),
      laps: clamp(parseInt(lapsEl.value, 10) || 3, 1, 100),
      env: {
        airTempC: 24, trackTempC: 32, airDensity: 1.225,
        rainMmH: 0, baseGrip: 1, windX: 0, windY: 0, ...weather?.env,
      },
      seed: (Math.random() * 1e9) | 0,
    });
  });
}

function startSession(config: WorldConfig): void {
  world = new World(config);
  renderer.buildTrackLayer(world.track);
  renderer.clearSkids();
  hud.buildSetup(world.player.car.setup, world.player.car.spec.name, () => {
    // Live setup changes: recompute what depends on mass and aero.
    world?.recomputeSpeedProfile();
  });
  hud.toggleSetup(false);
  menu.classList.add('hidden');
  hudRoot.style.opacity = '1';
  last = performance.now();
}

input.onKey = (code) => {
  if (!world) return;
  switch (code) {
    case 'KeyO': hud.toggleSetup(); break;
    case 'KeyT': hudRoot.classList.toggle('dim'); break;
    case 'KeyL': renderer.opts.showRacingLine = !renderer.opts.showRacingLine; break;
    case 'KeyM': renderer.opts.showMinimap = !renderer.opts.showMinimap; break;
    case 'KeyV': renderer.opts.showAiDebug = !renderer.opts.showAiDebug; break;
    case 'KeyC': renderer.opts.cameraLocked = !renderer.opts.cameraLocked; break;
    case 'KeyP': case 'Escape': paused = !paused; break;
    case 'KeyR':
      world.reset();
      renderer.clearSkids();
      hud.syncSetupInputs(world.player.car.setup);
      break;
    default: break;
  }
};

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
  last = now;
  if (!world) {
    renderer.resize();
    return;
  }
  const carInput = input.read(dt);
  if (!paused) {
    world.update(dt, carInput);
    hud.frame(world, dt);
  }
  renderer.frame(world, dt);
}

buildMenu();
hudRoot.style.opacity = '0';
requestAnimationFrame(loop);

/** Exposed for tinkering from the console during development. */
declare global {
  interface Window {
    sim?: { world: World | null; spec: (k: string) => CarSpec | undefined };
  }
}
window.sim = { world, spec: (k: string) => CAR_SPECS[k] };
