import { Track, SURFACES, SURFACE_TARMAC } from '../track/track.js';
import { World, Racer } from '../state/world.js';
import { kmh } from '../physics/vehicle.js';

interface Skid {
  x: number; y: number; a: number; w: number; age: number;
}

interface Puff {
  x: number; y: number; vx: number; vy: number; life: number; max: number; r: number;
}

export interface RenderOptions {
  showRacingLine: boolean;
  showAiDebug: boolean;
  showMinimap: boolean;
  cameraLocked: boolean;
}

/**
 * Top-down renderer. The track surface is pre-rendered once into an offscreen
 * canvas; per frame we only blit it and draw the moving things, which keeps a
 * 4 km circuit cheap at 60 fps.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private trackLayer: HTMLCanvasElement | null = null;
  private trackOrigin = { x: 0, y: 0 };
  private trackScale = 1;
  private skids: Skid[] = [];
  private puffs: Puff[] = [];
  private camX = 0;
  private camY = 0;
  private camZoom = 6;
  private camRot = 0;
  opts: RenderOptions = {
    showRacingLine: false, showAiDebug: false, showMinimap: true, cameraLocked: false,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
  }

  /** Rebuild the static track image. Call when the track or its paint changes. */
  buildTrackLayer(track: Track): void {
    const margin = track.margin + 30;
    const b = track.bounds_;
    const w = b.maxX - b.minX + margin * 2;
    const h = b.maxY - b.minY + margin * 2;
    // 2 pixels per metre is plenty for a top-down view and keeps memory sane.
    const px = 2;
    const cv = document.createElement('canvas');
    cv.width = Math.max(64, Math.floor(w * px));
    cv.height = Math.max(64, Math.floor(h * px));
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(px, px);
    g.translate(margin - b.minX, margin - b.minY);
    this.trackOrigin = { x: b.minX - margin, y: b.minY - margin };
    this.trackScale = px;

    // Ground.
    g.fillStyle = '#2c3a2a';
    g.fillRect(b.minX - margin, b.minY - margin, w, h);
    this.paintNoise(g, b, margin);

    const n = track.xs.length;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const h2 = track.heading[i];
      const nx = -Math.sin(h2);
      const ny = Math.cos(h2);
      const half = track.width[i] * 0.5;
      left.push([track.xs[i] + nx * half, track.ys[i] + ny * half]);
      right.push([track.xs[i] - nx * half, track.ys[i] - ny * half]);
    }

    // Run-off material painted per sample, outside the tarmac.
    for (let i = 0; i < n; i++) {
      const surf = track.surface[i];
      if (surf === SURFACE_TARMAC) continue;
      const props = SURFACES[surf] ?? SURFACES[2];
      const h2 = track.heading[i];
      const nx = -Math.sin(h2);
      const ny = Math.cos(h2);
      const half = track.width[i] * 0.5;
      const out = half + 12;
      g.fillStyle = props.color;
      g.globalAlpha = 0.75;
      g.beginPath();
      g.moveTo(track.xs[i] + nx * half, track.ys[i] + ny * half);
      g.lineTo(track.xs[i] + nx * out, track.ys[i] + ny * out);
      g.lineTo(track.xs[i] - nx * out, track.ys[i] - ny * out);
      g.lineTo(track.xs[i] - nx * half, track.ys[i] - ny * half);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
    }

    // Rumble strips: alternating red/white just outside the tarmac.
    for (let i = 0; i < n; i++) {
      const h2 = track.heading[i];
      const nx = -Math.sin(h2);
      const ny = Math.cos(h2);
      const half = track.width[i] * 0.5;
      g.fillStyle = Math.floor(i / 3) % 2 === 0 ? '#c8452f' : '#e8e8e8';
      for (const side of [1, -1]) {
        g.beginPath();
        g.moveTo(track.xs[i] + nx * half * side, track.ys[i] + ny * half * side);
        g.lineTo(track.xs[i] + nx * (half + 1.1) * side, track.ys[i] + ny * (half + 1.1) * side);
        const j = (i + 1) % n;
        const hj = track.heading[j];
        const nxj = -Math.sin(hj);
        const nyj = Math.cos(hj);
        const halfj = track.width[j] * 0.5;
        g.lineTo(track.xs[j] + nxj * (halfj + 1.1) * side, track.ys[j] + nyj * (halfj + 1.1) * side);
        g.lineTo(track.xs[j] + nxj * halfj * side, track.ys[j] + nyj * halfj * side);
        g.closePath();
        g.fill();
      }
    }

    // Tarmac.
    g.fillStyle = '#3b3f46';
    g.beginPath();
    g.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < n; i++) g.lineTo(left[i][0], left[i][1]);
    g.closePath();
    for (let i = n - 1; i >= 0; i--) {
      if (i === n - 1) g.moveTo(right[i][0], right[i][1]);
      else g.lineTo(right[i][0], right[i][1]);
    }
    g.closePath();
    g.fill('evenodd');

    // White edge lines.
    g.strokeStyle = 'rgba(230,235,240,0.5)';
    g.lineWidth = 0.28;
    for (const path of [left, right]) {
      g.beginPath();
      g.moveTo(path[0][0], path[0][1]);
      for (let i = 1; i < n; i++) g.lineTo(path[i][0], path[i][1]);
      g.closePath();
      g.stroke();
    }

    // Start/finish line.
    const sh = track.heading[0];
    const snx = -Math.sin(sh);
    const sny = Math.cos(sh);
    const hw = track.width[0] * 0.5;
    for (let k = -6; k < 6; k++) {
      g.fillStyle = k % 2 === 0 ? '#f0f0f0' : '#1a1a1a';
      const a = (k / 6) * hw;
      const b2 = ((k + 1) / 6) * hw;
      g.beginPath();
      g.moveTo(track.xs[0] + snx * a - Math.cos(sh) * 1.2, track.ys[0] + sny * a - Math.sin(sh) * 1.2);
      g.lineTo(track.xs[0] + snx * b2 - Math.cos(sh) * 1.2, track.ys[0] + sny * b2 - Math.sin(sh) * 1.2);
      g.lineTo(track.xs[0] + snx * b2 + Math.cos(sh) * 1.2, track.ys[0] + sny * b2 + Math.sin(sh) * 1.2);
      g.lineTo(track.xs[0] + snx * a + Math.cos(sh) * 1.2, track.ys[0] + sny * a + Math.sin(sh) * 1.2);
      g.closePath();
      g.fill();
    }

    this.trackLayer = cv;
  }

  private paintNoise(
    g: CanvasRenderingContext2D,
    b: { minX: number; minY: number; maxX: number; maxY: number },
    margin: number,
  ): void {
    // Deterministic-ish mottling so the infield is not a flat colour.
    g.globalAlpha = 0.06;
    for (let i = 0; i < 900; i++) {
      const x = b.minX - margin + Math.random() * (b.maxX - b.minX + margin * 2);
      const y = b.minY - margin + Math.random() * (b.maxY - b.minY + margin * 2);
      g.fillStyle = i % 2 ? '#3d5236' : '#22301f';
      g.fillRect(x, y, 6, 6);
    }
    g.globalAlpha = 1;
  }

  clearSkids(): void {
    this.skids = [];
    this.puffs = [];
  }

  frame(world: World, dt: number): void {
    this.resize();
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const player = world.player;

    // Camera: follow the player, look a little ahead, zoom with speed.
    const targetZoom = Math.max(2.4, 7.4 - player.car.speed * 0.045);
    this.camZoom += (targetZoom - this.camZoom) * Math.min(1, dt * 2.2);
    const lead = Math.min(28, player.car.speed * 0.5);
    const tx = player.car.x + Math.cos(player.car.heading) * lead;
    const ty = player.car.y + Math.sin(player.car.heading) * lead;
    this.camX += (tx - this.camX) * Math.min(1, dt * 5);
    this.camY += (ty - this.camY) * Math.min(1, dt * 5);
    if (!this.opts.cameraLocked) {
      let dRot = player.car.heading + Math.PI / 2 - this.camRot;
      while (dRot > Math.PI) dRot -= Math.PI * 2;
      while (dRot < -Math.PI) dRot += Math.PI * 2;
      this.camRot += dRot * Math.min(1, dt * 1.6);
    } else {
      this.camRot = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#22301f';
    ctx.fillRect(0, 0, W, H);

    const scale = this.camZoom * dpr;
    ctx.setTransform(scale, 0, 0, scale, W / 2, H / 2);
    ctx.rotate(-this.camRot);
    ctx.translate(-this.camX, -this.camY);

    if (this.trackLayer) {
      const px = 1 / this.trackScale;
      ctx.drawImage(this.trackLayer,
        this.trackOrigin.x, this.trackOrigin.y,
        this.trackLayer.width * px, this.trackLayer.height * px);
    }

    this.drawWater(world);
    this.updateSkids(world, dt);
    this.drawSkids(ctx);
    this.drawRubber(world, ctx);
    if (this.opts.showRacingLine) this.drawRacingLine(world, ctx);
    this.drawParticles(ctx, dt);
    for (const r of world.racers) this.drawCar(ctx, r, r === player);
    if (this.opts.showAiDebug) this.drawAiDebug(world, ctx);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.opts.showMinimap) this.drawMinimap(world, ctx, W / dpr, H / dpr);
    this.drawRain(world, ctx, W / dpr, H / dpr, dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawWater(world: World): void {
    const t = world.track;
    if (world.env.rainMmH <= 0 && t.water.every(w => w < 0.02)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#5b7f9c';
    for (let i = 0; i < t.xs.length; i += 2) {
      const depth = Math.min(1, t.water[i] / 3);
      if (depth < 0.03) continue;
      ctx.globalAlpha = 0.1 + depth * 0.3;
      const h = t.heading[i];
      const half = t.width[i] * 0.5 * (0.4 + depth * 0.6);
      ctx.beginPath();
      ctx.ellipse(t.xs[i], t.ys[i], half, 2.5, h, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private updateSkids(world: World, dt: number): void {
    for (const r of world.racers) {
      const car = r.car;
      const slip = Math.max(
        Math.abs(car.tyres[2].relaxedSlipRatio), Math.abs(car.tyres[3].relaxedSlipRatio),
        Math.abs(car.tyres[0].relaxedSlipAngle), Math.abs(car.tyres[1].relaxedSlipAngle) * 2,
      );
      if (car.speed > 3 && slip > 0.28) {
        const c = Math.cos(car.heading);
        const s = Math.sin(car.heading);
        for (const i of [2, 3]) {
          const p = car.wheelPosition(i);
          this.skids.push({
            x: car.x + p.x * c - p.y * s,
            y: car.y + p.x * s + p.y * c,
            a: Math.min(0.55, slip * 0.5),
            w: 0.42,
            age: 0,
          });
        }
        if (this.puffs.length < 260 && Math.random() < 0.5) {
          const p = car.wheelPosition(3);
          this.puffs.push({
            x: car.x + p.x * c - p.y * s,
            y: car.y + p.x * s + p.y * c,
            vx: (Math.random() - 0.5) * 3,
            vy: (Math.random() - 0.5) * 3,
            life: 0, max: 0.5 + Math.random() * 0.5,
            r: 0.8 + Math.random() * 1.4,
          });
        }
      }
      void dt;
    }
    if (this.skids.length > 9000) this.skids.splice(0, this.skids.length - 9000);
  }

  private drawSkids(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = '#14161a';
    for (const s of this.skids) {
      ctx.globalAlpha = s.a;
      ctx.fillRect(s.x - s.w * 0.5, s.y - s.w * 0.5, s.w, s.w);
    }
    ctx.restore();
  }

  private drawRubber(world: World, ctx: CanvasRenderingContext2D): void {
    const t = world.track;
    let any = false;
    for (let i = 0; i < t.rubber.length; i += 4) {
      if (t.rubber[i] > 0.03) { any = true; break; }
    }
    if (!any) return;
    ctx.save();
    ctx.strokeStyle = '#1b1d21';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < t.xs.length; i += 2) {
      if (t.rubber[i] < 0.03) continue;
      ctx.globalAlpha = Math.min(0.5, t.rubber[i] * 0.6);
      ctx.moveTo(t.xs[i], t.ys[i]);
      const j = (i + 2) % t.xs.length;
      ctx.lineTo(t.xs[j], t.ys[j]);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawRacingLine(world: World, ctx: CanvasRenderingContext2D): void {
    const t = world.track;
    const line = world.line;
    const speeds = world.speedLimit;
    const n = line.lateral.length;
    ctx.save();
    ctx.lineWidth = 0.5;
    for (let i = 0; i < n; i += 2) {
      const h = t.heading[i];
      const x = t.xs[i] - Math.sin(h) * line.lateral[i];
      const y = t.ys[i] + Math.cos(h) * line.lateral[i];
      const j = (i + 2) % n;
      const hj = t.heading[j];
      const x2 = t.xs[j] - Math.sin(hj) * line.lateral[j];
      const y2 = t.ys[j] + Math.cos(hj) * line.lateral[j];
      const v = speeds[i] ?? 30;
      ctx.strokeStyle = speedColor(v);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number): void {
    ctx.save();
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += dt * 2.2;
      if (p.life >= p.max) {
        this.puffs.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = 0.28 * (1 - p.life / p.max);
      ctx.fillStyle = '#c9cdd2';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCar(ctx: CanvasRenderingContext2D, r: Racer, isPlayer: boolean): void {
    const car = r.car;
    const spec = car.spec;
    const L = spec.halfLength * 2;
    const Wd = spec.halfWidth * 2;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);

    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-L * 0.5 + 0.35, -Wd * 0.5 + 0.4, L, Wd);

    // Wheels, turned by the steering angle at the front.
    ctx.fillStyle = '#15171b';
    for (let i = 0; i < 4; i++) {
      const p = car.wheelPosition(i);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (i < 2) ctx.rotate(car.steeringAngle);
      ctx.fillRect(-0.33, -0.17, 0.66, 0.34);
      ctx.restore();
    }

    // Body.
    ctx.fillStyle = r.color;
    roundRect(ctx, -L * 0.5, -Wd * 0.5, L, Wd, 0.35);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(ctx, -L * 0.16, -Wd * 0.36, L * 0.34, Wd * 0.72, 0.2);
    ctx.fill();
    // Nose marker so you can read the heading at a glance.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(L * 0.36, -Wd * 0.16, L * 0.12, Wd * 0.32);

    if (isPlayer) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 0.14;
      roundRect(ctx, -L * 0.5, -Wd * 0.5, L, Wd, 0.35);
      ctx.stroke();
    }
    ctx.restore();

    // Number + name above the car.
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(-this.camRot * 0);
    ctx.fillStyle = isPlayer ? '#ffffff' : 'rgba(223,230,238,0.72)';
    ctx.font = '1.7px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(r.number), 0, -Wd * 0.9);
    if (!isPlayer) {
      ctx.fillStyle = 'rgba(180,192,205,0.6)';
      ctx.font = '1.3px ui-monospace, monospace';
      ctx.fillText(r.name, 0, -Wd * 1.7);
    }
    if (r.blueFlag) {
      ctx.fillStyle = '#3b6fd4';
      ctx.font = '1.5px ui-monospace, monospace';
      ctx.fillText('BLUE', 0, Wd * 1.8);
    }
    ctx.restore();
    void kmh;
  }

  private drawAiDebug(world: World, ctx: CanvasRenderingContext2D): void {
    ctx.save();
    for (const r of world.racers) {
      if (!r.opponent) continue;
      const d = r.opponent.debug;
      ctx.strokeStyle = 'rgba(78,201,176,0.75)';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.moveTo(r.car.x, r.car.y);
      ctx.lineTo(d.targetX, d.targetY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(78,201,176,0.9)';
      ctx.beginPath();
      ctx.arc(d.targetX, d.targetY, 0.5, 0, Math.PI * 2);
      ctx.fill();
      // Friction budget used, as a bar over the car.
      const u = Math.min(1.3, r.car.outOfGrip);
      ctx.fillStyle = u > 1 ? '#e23b3b' : '#f2c14e';
      ctx.fillRect(r.car.x - 1.6, r.car.y + 1.9, 3.2 * (u / 1.3), 0.28);
    }
    ctx.restore();
  }

  private drawMinimap(
    world: World, ctx: CanvasRenderingContext2D, cssW: number, cssH: number,
  ): void {
    const t = world.track;
    const b = t.bounds_;
    const size = 132;
    const pad = 12;
    const x0 = cssW - size - pad;
    const y0 = cssH - size - pad;
    const sx = (size - 12) / Math.max(1, b.maxX - b.minX);
    const sy = (size - 12) / Math.max(1, b.maxY - b.minY);
    const s = Math.min(sx, sy);
    const map = (wx: number, wy: number): [number, number] =>
      [x0 + 6 + (wx - b.minX) * s, y0 + 6 + (wy - b.minY) * s];

    ctx.save();
    ctx.fillStyle = 'rgba(12,15,19,0.72)';
    ctx.strokeStyle = '#2a323c';
    ctx.lineWidth = 1;
    ctx.fillRect(x0 - 4, y0 - 4, size + 8, size + 8);
    ctx.strokeRect(x0 - 4, y0 - 4, size + 8, size + 8);
    ctx.strokeStyle = 'rgba(200,210,220,0.55)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let i = 0; i < t.xs.length; i += 3) {
      const [px, py] = map(t.xs[i], t.ys[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    for (const r of world.racers) {
      const [px, py] = map(r.car.x, r.car.y);
      ctx.fillStyle = r.isPlayer ? '#ffffff' : r.color;
      ctx.beginPath();
      ctx.arc(px, py, r.isPlayer ? 3.4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawRain(
    world: World, ctx: CanvasRenderingContext2D, w: number, h: number, dt: number,
  ): void {
    const intensity = Math.min(1, world.env.rainMmH / 20);
    if (intensity <= 0.01) return;
    ctx.save();
    ctx.strokeStyle = `rgba(190,210,230,${0.10 + intensity * 0.22})`;
    ctx.lineWidth = 1;
    const drops = Math.floor(90 * intensity);
    this.rainSeed = (this.rainSeed + dt * 900) % 10000;
    for (let i = 0; i < drops; i++) {
      const x = ((i * 137.5 + this.rainSeed) % w);
      const y = ((i * 61.8 + this.rainSeed * 1.7) % h);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3, y + 12);
      ctx.stroke();
    }
    ctx.restore();
  }

  private rainSeed = 0;
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function speedColor(v: number): string {
  const t = Math.max(0, Math.min(1, (v - 12) / 68));
  const hue = 210 - t * 210;
  return `hsl(${hue}, 78%, ${46 + t * 12}%)`;
}
