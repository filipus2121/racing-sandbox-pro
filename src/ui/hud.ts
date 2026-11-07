import { World, StandingRow } from '../state/world.js';
import { CarSetup } from '../physics/cars.js';
import { Vehicle } from '../physics/vehicle.js';
import { formatLap, formatGap, clamp } from '../core/math.js';

interface SetupField {
  key: keyof CarSetup;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits: number;
}

const SETUP_FIELDS: SetupField[] = [
  { key: 'tyrePressureFront', label: 'Tyre pressure F', min: 1.2, max: 2.4, step: 0.01, unit: 'bar', digits: 2 },
  { key: 'tyrePressureRear', label: 'Tyre pressure R', min: 1.2, max: 2.4, step: 0.01, unit: 'bar', digits: 2 },
  { key: 'camberFront', label: 'Camber front', min: -5, max: 0, step: 0.1, unit: 'deg', digits: 1 },
  { key: 'camberRoll', label: 'Camber rear', min: -4, max: 0, step: 0.1, unit: 'deg', digits: 1 },
  { key: 'toeFront', label: 'Toe front', min: -0.4, max: 0.4, step: 0.01, unit: 'deg', digits: 2 },
  { key: 'toeRear', label: 'Toe rear', min: -0.4, max: 0.4, step: 0.01, unit: 'deg', digits: 2 },
  { key: 'rideHeightFront', label: 'Ride height F', min: 20, max: 90, step: 1, unit: 'mm', digits: 0 },
  { key: 'rideHeightRear', label: 'Ride height R', min: 20, max: 100, step: 1, unit: 'mm', digits: 0 },
  { key: 'springFront', label: 'Spring front', min: 0.6, max: 1.6, step: 0.02, unit: 'x', digits: 2 },
  { key: 'springRear', label: 'Spring rear', min: 0.6, max: 1.6, step: 0.02, unit: 'x', digits: 2 },
  { key: 'damperFront', label: 'Damper front', min: 0.6, max: 1.6, step: 0.02, unit: 'x', digits: 2 },
  { key: 'damperRear', label: 'Damper rear', min: 0.6, max: 1.6, step: 0.02, unit: 'x', digits: 2 },
  { key: 'arbFront', label: 'Anti-roll front', min: 0.2, max: 2.5, step: 0.05, unit: 'x', digits: 2 },
  { key: 'arbRear', label: 'Anti-roll rear', min: 0.2, max: 2.5, step: 0.05, unit: 'x', digits: 2 },
  { key: 'brakeBias', label: 'Brake bias F', min: 0.4, max: 0.72, step: 0.005, unit: '', digits: 3 },
  { key: 'diffLock', label: 'Diff lock', min: 0, max: 1, step: 0.02, unit: '', digits: 2 },
  { key: 'diffPreload', label: 'Diff preload', min: 0, max: 120, step: 2, unit: 'Nm', digits: 0 },
  { key: 'finalDrive', label: 'Final drive', min: 2.6, max: 5.4, step: 0.02, unit: '', digits: 2 },
  { key: 'wingFront', label: 'Wing front', min: 0, max: 14, step: 0.5, unit: 'deg', digits: 1 },
  { key: 'wingRear', label: 'Wing rear', min: 0, max: 18, step: 0.5, unit: 'deg', digits: 1 },
  { key: 'ballastKg', label: 'Ballast', min: 0, max: 80, step: 1, unit: 'kg', digits: 0 },
  { key: 'ballastPos', label: 'Ballast position', min: -1, max: 1, step: 0.05, unit: '', digits: 2 },
  { key: 'fuelLoadL', label: 'Fuel load', min: 0, max: 120, step: 1, unit: 'L', digits: 0 },
  { key: 'tcLevel', label: 'Traction control', min: 0, max: 1, step: 0.05, unit: '', digits: 2 },
  { key: 'absLevel', label: 'ABS', min: 0, max: 1, step: 0.05, unit: '', digits: 2 },
  { key: 'throttleMap', label: 'Throttle map', min: 0, max: 1, step: 0.05, unit: '', digits: 2 },
  { key: 'engineBrakeMap', label: 'Engine braking', min: 0, max: 1, step: 0.05, unit: '', digits: 2 },
];

/**
 * Heads-up display: timing tower, live telemetry, trace graph and the setup
 * sheet. Reads only what World exposes, so it stays honest about the sim state.
 */
export class Hud {
  private el = {
    tower: q('#tower'),
    lights: q('#lights'),
    flagMsg: q('#flag-msg'),
    speed: q('#speed'),
    rpmbar: q('#rpmbar'),
    rpm: q('#rpm'),
    gear: q('#gear'),
    thr: q('#thr'),
    brk: q('#brk'),
    str: q('#str'),
    gforce: q('#gforce'),
    tyres: q('#tyres'),
    lapno: q('#lapno'),
    lastlap: q('#lastlap'),
    bestlap: q('#bestlap'),
    curlap: q('#curlap'),
    messages: q('#messages'),
    aidebug: q('#aidebug'),
    setup: q('#setup'),
    setupFields: q('#setup-fields'),
    setupCar: q('#setup-car'),
  };
  private graph = q('#graph') as HTMLCanvasElement;
  private gctx = this.graph.getContext('2d');
  private trace: { v: number; thr: number; brk: number; g: number }[] = [];
  private shownMessages = 0;
  private inputs = new Map<string, HTMLInputElement>();
  private lastTower = '';

  constructor() {
    for (let i = 0; i < 5; i++) {
      const lamp = document.createElement('i');
      this.el.lights.appendChild(lamp);
    }
  }

  /** Build the setup sheet bound live to this car's setup object. */
  buildSetup(setup: CarSetup, specName: string, onChange: () => void): void {
    this.el.setupCar.textContent = specName;
    this.el.setupFields.innerHTML = '';
    this.inputs.clear();
    for (const f of SETUP_FIELDS) {
      const row = document.createElement('div');
      row.className = 'field';
      const label = document.createElement('span');
      label.textContent = f.label;
      const val = document.createElement('b');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      input.value = String(Number(setup[f.key]));
      const render = () => {
        val.textContent = `${Number(setup[f.key]).toFixed(f.digits)}${f.unit ? ' ' + f.unit : ''}`;
      };
      input.addEventListener('input', () => {
        (setup[f.key] as number) = parseFloat(input.value);
        render();
        onChange();
      });
      render();
      row.append(label, val, input);
      this.el.setupFields.appendChild(row);
      this.inputs.set(f.key as string, input);
    }
  }

  syncSetupInputs(setup: CarSetup): void {
    for (const [key, input] of this.inputs) {
      const v = Number(setup[key as keyof CarSetup]);
      if (Math.abs(parseFloat(input.value) - v) > 1e-9) input.value = String(v);
    }
  }

  toggleSetup(show?: boolean): boolean {
    const now = show ?? this.el.setup.classList.contains('hidden');
    this.el.setup.classList.toggle('hidden', !now);
    return now;
  }

  frame(world: World, dt: number): void {
    const car = world.player.car;
    const hud = world.hudData();

    // ---- telemetry ----
    this.el.speed.textContent = Math.round(hud.speed).toString();
    this.el.rpm.textContent = `${Math.round(hud.rpm)} rpm`;
    this.el.gear.textContent = gearLabel(car);
    const rpmFrac = clamp(
      (hud.rpm - car.spec.engine.idleRpm) /
      Math.max(1, car.spec.engine.redlineRpm - car.spec.engine.idleRpm), 0, 1);
    (this.el.rpmbar.firstChild as HTMLElement).style.width = `${(rpmFrac * 100).toFixed(1)}%`;
    this.el.thr.style.width = `${(hud.throttle * 100).toFixed(0)}%`;
    this.el.brk.style.width = `${(hud.brake * 100).toFixed(0)}%`;
    this.el.brk.style.background = '#f48771';
    const steerPct = clamp(hud.steer, -1, 1) * 50;
    this.el.str.style.width = `${Math.abs(steerPct).toFixed(1)}%`;
    this.el.str.style.left = steerPct >= 0 ? '50%' : `${(50 + steerPct).toFixed(1)}%`;

    // G-force dot: lateral across, longitudinal up.
    const gScale = 16;
    const dot = this.el.gforce.firstChild as HTMLElement;
    dot.style.transform = `translate(${clamp(hud.latG, -2.4, 2.4) * gScale}px, ` +
      `${clamp(-hud.longG, -2.4, 2.4) * gScale}px)`;
    const grip = car.outOfGrip;
    dot.style.background = grip > 1.02 ? '#e23b3b' : grip > 0.9 ? '#f2c14e' : '#f2c14e';

    // ---- tyre corners ----
    this.renderTyres(car, hud.temps, hud.wear);

    // ---- laps ----
    const p = world.player;
    this.el.lapno.textContent = `${Math.min(p.lap + 1, world.laps)}/${world.laps}`;
    this.el.lastlap.textContent = p.lastLap > 0 ? formatLap(p.lastLap) : '--';
    this.el.bestlap.textContent = p.bestLap > 0 ? formatLap(p.bestLap) : '--';
    this.el.curlap.textContent = p.lapStart > 0 ? formatLap(world.time - p.lapStart) : '0:00.0';

    // ---- trace graph ----
    this.trace.push({ v: hud.speed, thr: hud.throttle, brk: hud.brake, g: grip });
    const maxPts = 260;
    if (this.trace.length > maxPts) this.trace.splice(0, this.trace.length - maxPts);
    this.drawGraph(car);

    // ---- timing tower ----
    this.renderTower(world);

    // ---- start lights ----
    this.renderLights(world);

    // ---- messages ----
    if (world.messages.length !== this.shownMessages) {
      this.shownMessages = world.messages.length;
      this.el.messages.innerHTML = '';
      for (const m of world.messages.slice(-4)) {
        const div = document.createElement('div');
        div.className = m.kind;
        div.textContent = m.text;
        this.el.messages.appendChild(div);
      }
    }

    // ---- AI debug ----
    const opp = world.player.opponent;
    const target = world.racers.find(r => !r.isPlayer && r.opponent);
    if (target?.opponent) {
      const d = target.opponent.debug;
      this.el.aidebug.innerHTML =
        `<b>${target.name}</b> ${target.opponent.describe(target.car)}<br>` +
        `target ${Math.round(d.targetSpeed * 3.6)} km/h · limit ${Math.round(d.speedLimitAt * 3.6)}<br>` +
        `line offset ${d.lineOffset.toFixed(2)} · mistake ${d.mistake.toFixed(2)}<br>${d.note}`;
    } else {
      this.el.aidebug.textContent = opp ? '' : 'no opponents';
    }
    void dt;
  }

  private renderTyres(car: Vehicle, temps: number[], wear: number): void {
    if (this.el.tyres.childElementCount !== 4) {
      this.el.tyres.innerHTML = '';
      for (const label of ['FL', 'FR', 'RL', 'RR']) {
        const d = document.createElement('div');
        d.innerHTML = `<span class="t">${label}</span><span class="v">--</span>`;
        this.el.tyres.appendChild(d);
      }
    }
    for (let i = 0; i < 4; i++) {
      const t = car.tyres[i];
      const v = this.el.tyres.children[i].querySelector('.v') as HTMLElement;
      const temp = temps[i] ?? t.surfaceTemp;
      const wearI = clamp(1 - (t.wear ?? 0), 0, 1);
      v.textContent = `${Math.round(temp)}° ${Math.round(wearI * 100)}%`;
      v.style.color = temp > t.coreTemp + 22 || temp < t.coreTemp - 22 ? '#f48771' : '#dfe6ee';
    }
    void wear;
  }

  private drawGraph(car: Vehicle): void {
    const g = this.gctx;
    if (!g) return;
    const W = this.graph.width;
    const H = this.graph.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = '#1d242c';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(0, (H / 4) * i);
      g.lineTo(W, (H / 4) * i);
      g.stroke();
    }
    const n = this.trace.length;
    if (n < 2) return;
    const x = (i: number) => (i / (n - 1)) * W;
    const top = car.spec.engine.redlineRpm;

    const line = (get: (p: { v: number; thr: number; brk: number; g: number }) => number,
      color: string, max: number) => {
      g.strokeStyle = color;
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const y = H - clamp(get(this.trace[i]) / max, 0, 1) * (H - 4) - 2;
        if (i === 0) g.moveTo(x(i), y);
        else g.lineTo(x(i), y);
      }
      g.stroke();
    };

    line(p => p.v, '#4ec9b0', 320);          // speed km/h
    line(p => p.g, '#f2c14e', 1.3);          // friction used
    line(p => p.thr, 'rgba(120,200,140,0.7)', 1);
    line(p => p.brk, 'rgba(244,135,113,0.7)', 1);

    g.fillStyle = '#8b98a7';
    g.font = '9px ui-monospace, monospace';
    g.fillText(`${Math.round(top / 100) * 100 / 1000}k`, 3, 10);
    g.fillText('320', 3, H - 3);
  }

  private renderTower(world: World): void {
    const rows = world.standings();
    // Rebuild only when the order or the lap times actually change.
    const key = rows.map(r => `${r.position}${r.laps}${Math.round(r.lastLap)}${r.finished ? 'f' : ''}`).join('|');
    if (key === this.lastTower) {
      this.updateTowerTimes(world, rows);
      return;
    }
    this.lastTower = key;
    const table = document.createElement('table');
    table.innerHTML = '<tr><th></th><th>DRIVER</th><th class="gp">GAP</th><th class="gp">LAST</th></tr>';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.racer.isPlayer) tr.className = 'you';
      tr.dataset.num = String(r.racer.number);
      tr.innerHTML =
        `<td class="pos">${r.position}</td>` +
        `<td class="nm"><span style="color:${r.racer.color}">■</span> ${escapeHtml(r.racer.name)}</td>` +
        `<td class="gp" data-gap></td>` +
        `<td class="gp" data-last></td>`;
      table.appendChild(tr);
    }
    this.el.tower.innerHTML = '';
    this.el.tower.appendChild(table);
    this.updateTowerTimes(world, rows);
  }

  private updateTowerTimes(world: World, rows: StandingRow[]): void {
    const table = this.el.tower.querySelector('table');
    if (!table) return;
    for (const r of rows) {
      const tr = table.querySelector(`tr[data-num="${r.racer.number}"]`) as HTMLElement | null;
      if (!tr) continue;
      const gap = tr.querySelector('[data-gap]') as HTMLElement;
      const last = tr.querySelector('[data-last]') as HTMLElement;
      gap.textContent = r.position === 1
        ? (r.finished ? 'FIN' : `${r.laps}L`)
        : formatGap(r.gapToLeader);
      last.textContent = r.lastLap > 0 ? formatLap(r.lastLap) : '--';
      last.style.color = world.fastestLap.ms > 0 && r.bestLap > 0 &&
        Math.abs(r.bestLap - world.fastestLap.ms) < 1 ? '#c586c0' : '';
      const wear = tr.querySelector('.wearbar') as HTMLElement | null;
      if (wear) {
        const fill = wear.firstChild as HTMLElement;
        fill.style.width = `${clamp(1 - r.tyreWear, 0, 1) * 100}%`;
      }
    }
  }

  private renderLights(world: World): void {
    const lamps = this.el.lights.children;
    const t = world.countdown;
    for (let i = 0; i < lamps.length; i++) {
      const lamp = lamps[i] as HTMLElement;
      lamp.className = '';
      if (world.started) {
        if (t < -0.6) lamp.classList.add('go');
      } else if (t <= 5 - i) {
        lamp.classList.add('on');
      }
    }
    const flag = world.messages.filter(m => m.kind === 'flag').pop();
    this.el.flagMsg.textContent = !world.started
      ? (t > 0 ? `Formation — ${t.toFixed(1)}` : 'GO')
      : world.finished ? 'CHEQUERED' : (flag?.text ?? '');
  }
}

function gearLabel(car: Vehicle): string {
  if (car.shiftTimer > 0) return '·';
  if (car.gear === 0) return 'N';
  if (car.gear < 0) return 'R';
  return String(car.gear);
}

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as HTMLElement;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
