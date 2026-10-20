// Slanje događaja collector-u (core/spec/events.md §1): koverta kao `text/plain` preko
// `sendBeacon` — bez CORS preflight-a, i radi i dok se stranica zatvara.

export interface BrowserEvent {
  type: "view" | "engage" | "compose" | "honeypot";
  vid: string;
  t: number;
  [field: string]: unknown;
}

export type Beacon = (url: string, body: string) => boolean;

const MAX_EVENTS = 100;

export class Sender {
  private queue: BrowserEvent[] = [];

  constructor(
    private readonly url: string,
    private readonly portal: string,
    private readonly beacon: Beacon = defaultBeacon,
  ) {}

  push(e: BrowserEvent): void {
    this.queue.push(e);
    if (this.queue.length >= MAX_EVENTS) this.flush();
  }

  /** Šalje sve iz reda. Neuspeh se ne ponavlja: browser ne sme da zavisi od nas. */
  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0, MAX_EVENTS);
    this.beacon(this.url, JSON.stringify({ v: 1, portal: this.portal, sent_ms: Date.now(), events }));
    if (this.queue.length) this.flush();
  }
}

function defaultBeacon(url: string, body: string): boolean {
  // String telo → `text/plain;charset=UTF-8`.
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      return navigator.sendBeacon(url, body);
    } catch {
      return false;
    }
  }
  return false;
}
