import { Rng, clamp } from '../core/math.js';
import { Track } from '../track/track.js';

export type Flag = 'green' | 'caution' | 'white' | 'checkered';

/**
 * Where we are inside a caution.
 *
 *   deploy  - lap 1: yellow just flew, the pace car is picking the field up
 *             and everyone runs single file. Nobody passes.
 *   reform  - lap 2: the field sorts itself into two rows in the order it was
 *             running when the yellow came out
 *   hold    - lap 3: formation held, pace car peels off near the end of it and
 *             the green waves as the field reaches the line
 *   none    - green flag racing
 */
export type CautionPhase = 'none' | 'deploy' | 'reform' | 'hold';

export interface RaceControlConfig {
  laps: number;
  /** Laps spent behind the pace car before the green waves again. */
  paceCarLaps: number;
  /** Green-white-checkered: how many two-lap attempts the race allows. */
  maxOvertimeAttempts: number;
  enableGwc: boolean;
  enablePaceCar: boolean;
}

export const DEFAULT_RACE_CONTROL: RaceControlConfig = {
  laps: 20,
  paceCarLaps: 3,
  maxOvertimeAttempts: 3,
  enableGwc: true,
  enablePaceCar: true,
};

/** Double-file restart geometry, metres from the track centreline. */
export const RESTART_LATERALS = [-6.05, -2.45];
/** Gap between rows of the restart formation, m. */
export const RESTART_ROW_GAP = 11;
/** How far behind the pace car the front row sits, m. */
export const RESTART_LEAD_GAP = 14;

export interface CautionRecord {
  at: number;
  reason: string;
  lap: number;
  overtime: boolean;
}

/**
 * The race director: flags, cautions, the pace car protocol, restarts and
 * green-white-checkered.
 *
 * Kept free of any physics so it can be driven from a test with nothing but a
 * lap counter, and so the rules cannot be broken by a change to the car model.
 */
export class RaceControl {
  readonly rng: Rng;
  flag: Flag = 'green';
  phase: CautionPhase = 'none';
  lapsScheduled: number;
  readonly cfg: RaceControlConfig;

  /** Cautions thrown, and why. */
  readonly cautions: CautionRecord[] = [];
  /** Number of the leader's completed laps. */
  leaderLaps = 0;
  /** True once the leader has taken the white flag. */
  whiteFlag = false;
  /** True once the leader has taken the checkered. */
  raceOver = false;
  overtimeAttempts = 0;
  inOvertime = false;
  /** Green-white-checkered attempt is running. */
  gwcLapsLeft = 0;

  /** Running order when the yellow flew, racer indices, leader first. */
  frozenOrder: number[] = [];
  /** Racer index -> restart slot, or absent when they are not in the formation. */
  slots = new Map<number, number>();
  /** Laps completed behind the pace car this caution. */
  paceLaps = 0;
  /** Fraction of the current caution lap the pace car has covered, 0..1. */
  paceLapProgress = 0;
  /** The pace car has pulled off and is out of the way. */
  paceCarPeeling = false;
  /** True between the yellow flying and the field being collected. */
  collecting = false;
  lastMessage = '';

  constructor(cfg: Partial<RaceControlConfig> = {}, seed = 1) {
    this.cfg = { ...DEFAULT_RACE_CONTROL, ...cfg };
    this.lapsScheduled = this.cfg.laps;
    this.rng = new Rng(seed);
  }

  reset(laps?: number): void {
    this.flag = 'green';
    this.phase = 'none';
    this.lapsScheduled = laps ?? this.cfg.laps;
    this.cautions.length = 0;
    this.leaderLaps = 0;
    this.whiteFlag = false;
    this.raceOver = false;
    this.overtimeAttempts = 0;
    this.inOvertime = false;
    this.gwcLapsLeft = 0;
    this.frozenOrder = [];
    this.slots.clear();
    this.paceLaps = 0;
    this.paceLapProgress = 0;
    this.paceCarPeeling = false;
    this.collecting = false;
  }

  get isRacing(): boolean {
    return this.flag === 'green' && !this.raceOver;
  }

  get underCaution(): boolean {
    return this.flag === 'caution';
  }

  /** Laps remaining for the leader, for the HUD. */
  get lapsToGo(): number {
    return Math.max(0, this.lapsScheduled - this.leaderLaps);
  }

  /**
   * Throw a yellow.
   *
   * Returns true when the yellow actually flew (it can only fly from green).
   * Green-white-checkered is decided here, because that is the moment the rule
   * applies: if the caution comes out with two laps or fewer to go and the
   * leader has not yet taken the white flag, the race is extended by two laps
   * for one attempt at a green finish.
   */
  throwCaution(time: number, reason: string, order: number[]): boolean {
    if (this.flag !== 'green' || this.raceOver) return false;
    this.flag = 'caution';
    this.phase = 'deploy';
    this.frozenOrder = order.slice();
    this.slots.clear();
    this.paceLaps = 0;
    this.paceLapProgress = 0;
    this.paceCarPeeling = false;
    this.collecting = true;

    let overtime = false;
    if (this.cfg.enableGwc && this.lapsToGo <= 2 && !this.whiteFlag) {
      this.overtimeAttempts += 1;
      if (this.overtimeAttempts <= this.cfg.maxOvertimeAttempts) {
        this.lapsScheduled += 2;
        this.inOvertime = true;
        this.gwcLapsLeft = 2;
        overtime = true;
      } else {
        // Attempts exhausted: the race will end under caution at the distance.
        this.raceOver = true;
        this.flag = 'checkered';
        this.phase = 'none';
        this.lastMessage = `Overtime attempts exhausted - final under caution`;
        return true;
      }
    }

    this.cautions.push({
      at: time, reason, lap: this.leaderLaps, overtime,
    });
    this.lastMessage = overtime
      ? `CAUTION - ${reason}. OVERTIME: green-white-checkered`
      : `CAUTION - ${reason}`;
    return true;
  }

  /**
   * The pace car crossed the start/finish line, i.e. it has completed one more
   * lap under caution. With the default three-lap protocol that walks the
   * caution through: lap 1 collecting the field single file, lap 2 reforming
   * into two rows in the order the race was running, lap 3 holding the
   * formation and then waving the green as the field comes to the line.
   */
  paceCarLapDone(order: number[]): void {
    this.paceLaps += 1;
    this.paceLapProgress = 0;
    const n = this.cfg.paceCarLaps;
    if (this.paceLaps >= n) {
      this.waveGreen();
    } else if (this.paceLaps >= n - 1) {
      this.phase = 'hold';
      this.lastMessage = 'One to go - hold your position';
    } else if (this.paceLaps >= n - 2) {
      this.phase = 'reform';
      this.assignSlots(order);
      this.lastMessage = 'Reform to double file - hold your row';
    }
  }

  private assignSlots(order: number[]): void {
    this.slots.clear();
    // The order to reform into is the one the race was running when the yellow
    // flew, not the order the field happens to be in now. Cars that pitted under
    // caution keep the slot they had, which is the rule and also what stops a
    // pit stop from costing a driver the track position they already held.
    const source = this.frozenOrder.length ? this.frozenOrder : order;
    source.forEach((racerIndex, i) => {
      this.slots.set(racerIndex, i);
    });
  }

  private waveGreen(): void {
    this.flag = 'green';
    this.phase = 'none';
    this.slots.clear();
    this.paceCarPeeling = true;
    this.collecting = false;
    this.inOvertime = this.gwcLapsLeft > 0;
    this.lastMessage = this.gwcLapsLeft > 0
      ? 'GREEN - green flag, white flag lap to come'
      : 'GREEN GREEN GREEN!';
  }

  /**
   * A racer completed a lap. Only the leader's laps drive the flags; everyone
   * else just gets counted.
   *
   * Returns a message to show, or ''.
   */
  lapCompleted(isLeader: boolean): string {
    if (!isLeader || this.raceOver) return '';
    this.leaderLaps += 1;
    if (this.gwcLapsLeft > 0) this.gwcLapsLeft -= 1;

    if (this.leaderLaps >= this.lapsScheduled) {
      this.raceOver = true;
      this.flag = 'checkered';
      this.phase = 'none';
      return this.inOvertime ? 'CHECKERED - race official after overtime' : 'CHECKERED FLAG';
    }
    if (this.leaderLaps === this.lapsScheduled - 1 && !this.whiteFlag) {
      this.whiteFlag = true;
      this.flag = this.flag === 'caution' ? 'caution' : 'white';
      return 'WHITE FLAG - one lap to go';
    }
    if (this.whiteFlag && this.flag === 'white') this.flag = 'green';
    return '';
  }

  /**
   * World position for a restart slot, given where the pace car is.
   *
   * Rows are numbered back from the pace car; each row holds two cars, inside
   * and outside. Returning null means "no slot assigned", which happens for a
   * car that was not running when the yellow flew.
   */
  slotPose(
    track: Track, paceS: number, slot: number,
  ): { x: number; y: number; heading: number } | null {
    if (slot < 0) return null;
    const row = Math.floor(slot / 2);
    const side = slot % 2;
    const s = paceS - RESTART_LEAD_GAP - row * RESTART_ROW_GAP;
    return track.pointAt(track.wrap(s), RESTART_LATERALS[side]);
  }

  /** Progress of the current caution lap, 0..1, from the pace car's position. */
  updatePaceProgress(paceS: number, prevPaceS: number, trackLength: number): void {
    let d = paceS - prevPaceS;
    if (d < -trackLength * 0.5) d += trackLength;
    if (d > trackLength * 0.5) d -= trackLength;
    this.paceLapProgress = clamp(this.paceLapProgress + d / trackLength, 0, 0.999);
  }

  /** Should the pace car start pulling off the racing line? */
  shouldPeel(): boolean {
    return this.phase === 'hold' && this.paceLapProgress > 0.72;
  }
}
