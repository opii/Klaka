// Sažetak čitanja jednog prikaza (`engage`, core/spec/events.md §2). Čist akumulator: vreme
// i položaj mu daje DOM sloj (track.ts), pa se testira bez browsera.

import { decile } from "./measure.js";

export const SEEN_MAX = 200;
/** Skok: promena dubine veća od 25% za manje od 100 ms (scrollIntoView, sidro). */
const JUMP_DEPTH = 250;
const JUMP_MS = 100;

export interface EngageFields {
  dwell_ms: number;
  visible_ms: number;
  depth_max: number;
  depth_hist: number[];
  jumps: number;
  first_input_ms: number | null;
  inputs: { key: number; ptr: number; touch: number };
  comments_ms: number | null;
  seq: number;
  seen: string[];
}

export class Engage {
  private visibleMs = 0;
  private depthMax = 0;
  private readonly hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  private jumps = 0;
  private firstInput: number | null = null;
  private readonly inputs = { key: 0, ptr: 0, touch: 0 };
  private commentsAt: number | null = null;
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  private seq = 0;
  private lastTick: number;
  private lastScroll: { at: number; depth: number } | null = null;

  /** `start` = trenutak prikaza (ms, isti sat kao svi ostali pozivi). */
  constructor(private readonly start: number) {
    this.lastTick = start;
  }

  /** Periodično: vreme od prošlog poziva ide u `visible_ms` i u desetinu gde je sredina ekrana. */
  tick(now: number, visible: boolean, centerDepth: number): void {
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!visible) return;
    this.visibleMs += dt;
    this.hist[decile(centerDepth)]! += dt;
  }

  /** Na svaki scroll: `bottomDepth` = dubina donje ivice ekrana. */
  scroll(now: number, bottomDepth: number): void {
    this.depthMax = Math.max(this.depthMax, bottomDepth);
    const last = this.lastScroll;
    if (last && now - last.at < JUMP_MS && Math.abs(bottomDepth - last.depth) > JUMP_DEPTH) this.jumps++;
    this.lastScroll = { at: now, depth: bottomDepth };
  }

  input(kind: "key" | "ptr" | "touch", now: number): void {
    this.inputs[kind]++;
    if (this.firstInput === null) this.firstInput = Math.max(0, now - this.start);
  }

  commentsVisible(now: number): void {
    if (this.commentsAt === null) this.commentsAt = Math.max(0, now - this.start);
  }

  /** Komentar je bio vidljiv (≥ 50% bar 500 ms — to proverava DOM sloj). */
  seenComment(id: string): void {
    if (this.seen.length >= SEEN_MAX || this.seenSet.has(id)) return;
    this.seenSet.add(id);
    this.seen.push(id);
  }

  /**
   * Sažetak do sada; svaki poziv povećava `seq` (važi poslednji). Vremena su celi ms: sat
   * (`performance.now()`) daje i delove milisekunde, a collector prima samo cele brojeve.
   */
  snapshot(now: number): EngageFields {
    const ms = (x: number | null) => (x === null ? null : Math.round(x));
    return {
      dwell_ms: Math.round(Math.max(0, now - this.start)),
      visible_ms: Math.round(this.visibleMs),
      depth_max: this.depthMax,
      depth_hist: this.hist.map(Math.round),
      jumps: this.jumps,
      first_input_ms: ms(this.firstInput),
      inputs: { ...this.inputs },
      comments_ms: ms(this.commentsAt),
      seq: this.seq++,
      seen: this.seen.slice(),
    };
  }
}
