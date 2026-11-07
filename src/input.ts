import { CarInput } from './physics/vehicle.js';

/** Keyboard + gamepad input, smoothed so the sim never sees a step change. */
export class Input {
  private keys = new Set<string>();
  private steer = 0;
  private throttle = 0;
  private brake = 0;
  private shiftUpLatch = false;
  private shiftDownLatch = false;
  gamepadIndex: number | null = null;

  attach(target: EventTarget = window): void {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.onKey?.(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => { this.keys.delete(e.code); };
    target.addEventListener('keydown', down as unknown as EventListener);
    target.addEventListener('keyup', up as EventListener);
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
    });
  }

  /** Fired once per physical press, for toggles and gear changes. */
  onKey: ((code: string) => void) | null = null;

  private held(...codes: string[]): boolean {
    return codes.some(c => this.keys.has(c));
  }

  read(dt: number): CarInput {
    const pad = this.gamepadIndex !== null
      ? navigator.getGamepads?.()[this.gamepadIndex] ?? null
      : null;

    let steerTarget = 0;
    let thr = 0;
    let brk = 0;
    let hand = 0;

    if (this.held('KeyA', 'ArrowLeft')) steerTarget -= 1;
    if (this.held('KeyD', 'ArrowRight')) steerTarget += 1;
    if (this.held('KeyW', 'ArrowUp')) thr = 1;
    if (this.held('KeyS', 'ArrowDown')) brk = 1;
    if (this.held('Space')) hand = 1;

    if (pad) {
      const axis = Math.abs(pad.axes[0] ?? 0) > 0.08 ? pad.axes[0] : 0;
      steerTarget = Math.abs(axis) > Math.abs(steerTarget) ? axis : steerTarget;
      thr = Math.max(thr, pad.buttons[7]?.value ?? 0);
      brk = Math.max(brk, pad.buttons[6]?.value ?? 0);
      hand = Math.max(hand, (pad.buttons[0]?.pressed ?? false) ? 1 : 0);
      if (pad.buttons[4]?.pressed && !this.shiftUpLatch) this.pendingUp = true;
      this.shiftUpLatch = pad.buttons[4]?.pressed ?? false;
      if (pad.buttons[5]?.pressed && !this.shiftDownLatch) this.pendingDown = true;
      this.shiftDownLatch = pad.buttons[5]?.pressed ?? false;
    }

    // Rate-limit so a human-sized input, not a step function, reaches the sim.
    const steerRate = 4.5 * dt;
    this.steer += Math.max(-steerRate, Math.min(steerRate, steerTarget - this.steer));
    this.throttle += Math.max(-6 * dt, Math.min(6 * dt, thr - this.throttle));
    this.brake += Math.max(-10 * dt, Math.min(10 * dt, brk - this.brake));

    const up = this.pendingUp || this.consume('ShiftLeft', 'ShiftRight', 'KeyE');
    const down = this.pendingDown || this.consume('ControlLeft', 'ControlRight', 'KeyQ');
    this.pendingUp = false;
    this.pendingDown = false;

    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: Math.max(-1, Math.min(1, this.steer)),
      clutch: this.held('KeyC') ? 1 : 0,
      shiftUp: up,
      shiftDown: down,
      handbrake: hand,
    };
  }

  private pendingUp = false;
  private pendingDown = false;

  /** True on the frame the key went down (single-shot). */
  private consume(...codes: string[]): boolean {
    for (const c of codes) {
      if (this.keys.has(c)) {
        this.keys.delete(c);
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.keys.clear();
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
  }
}
