// Događaji sa backenda portala (core/spec/events.md §3) i njihovo slanje collector-u.
//
// Slanje nikad ne blokira portal (sdk.md §2, korak 5): `send` samo stavlja događaj u bafer, a
// pozadinski tajmer šalje koverte. Ako collector ne odgovara, događaji se posle kratkog
// zadržavanja odbacuju — akcija korisnika je već obrađena.

import type { TokenResult } from "./token.js";

export interface ActionFields {
  t: number;
  post: string;
  vid: string | null;
  token: TokenResult;
  uses: number | null;
  decision: "count" | "shadow" | "challenge";
  net: string;
  ua: string;
  cid?: string | null;
}

export interface VoteEvent extends ActionFields {
  type: "vote";
  target: string;
  target_author: string | null;
  dir: 1 | -1;
}

export interface CommentEvent extends ActionFields {
  type: "comment";
  comment: string;
  author: string;
  text: string;
  reply_to: string | null;
}

export interface ModerationEvent {
  type: "moderation";
  t: number;
  comment: string;
  result: "approved" | "rejected";
  reason: string | null;
}

export interface PostEvent {
  type: "post";
  t: number;
  post: string;
  rev: number;
  url: string;
  title: string;
  section: string | null;
  body?: string | null;
}

export interface PromotionEvent {
  type: "promotion";
  t: number;
  post: string;
  channel: "push" | "homepage" | "newsletter" | "social" | "other";
}

export type ServerEvent = VoteEvent | CommentEvent | ModerationEvent | PostEvent | PromotionEvent;

export const UA_MAX_BYTES = 512;

/** User-agent skraćen na 512 bajtova UTF-8, bez sečenja znaka na pola (events.md §3). */
export function truncateUa(ua: string | undefined): string {
  if (!ua) return "";
  const buf = Buffer.from(ua, "utf8");
  if (buf.length <= UA_MAX_BYTES) return ua;
  let end = UA_MAX_BYTES;
  // Bajtovi oblika 10xxxxxx su nastavak znaka.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export interface SenderConfig {
  portal: string;
  collectorUrl: string;
  apiKey: string;
  /** Koliko često se bafer prazni. */
  flushMs?: number;
  /** Najviše događaja u baferu; preko toga se novi odbacuju. */
  maxBuffer?: number;
  /** Događaj stariji od ovoga se ne šalje ponovo posle neuspeha. */
  maxAgeMs?: number;
  timeoutMs?: number;
  /** Za testove. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SenderStats {
  sent: number;
  dropped: number;
}

// Koverta ≤ 100 događaja i ≤ 64 KB (events.md §1); ostavlja se rezerva za omotač.
const MAX_EVENTS = 100;
const MAX_ENVELOPE_BYTES = 60 * 1024;

interface Queued {
  json: string;
  bytes: number;
  queuedAt: number;
}

export class EventSender {
  readonly stats: SenderStats = { sent: 0, dropped: 0 };
  private readonly cfg: Required<Omit<SenderConfig, "fetch" | "now">>;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly url: string;
  private buffer: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(cfg: SenderConfig) {
    this.cfg = {
      portal: cfg.portal,
      collectorUrl: cfg.collectorUrl,
      apiKey: cfg.apiKey,
      flushMs: cfg.flushMs ?? 1_000,
      maxBuffer: cfg.maxBuffer ?? 10_000,
      maxAgeMs: cfg.maxAgeMs ?? 30_000,
      timeoutMs: cfg.timeoutMs ?? 2_000,
    };
    this.fetch = cfg.fetch ?? globalThis.fetch;
    this.now = cfg.now ?? Date.now;
    this.url = `${cfg.collectorUrl.replace(/\/+$/, "")}/v1/ingest`;
  }

  /** Stavlja događaj u red. Ne baca izuzetak i ne čeka mrežu. */
  send(event: ServerEvent): void {
    if (this.buffer.length >= this.cfg.maxBuffer) {
      this.stats.dropped++;
      return;
    }
    const json = JSON.stringify(event);
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_ENVELOPE_BYTES) {
      this.stats.dropped++;
      return;
    }
    this.buffer.push({ json, bytes, queuedAt: this.now() });
    this.timer ??= setTimeout(() => void this.flush(), this.cfg.flushMs).unref();
  }

  /** Šalje sve iz bafera (jedna po jedna koverta). Za gašenje procesa i testove. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Jedno slanje u isto vreme; drugi poziv čeka prvo pa nastavlja sa onim što je ostalo.
    while (this.inFlight) await this.inFlight;
    this.inFlight = this.drain();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.take();
      const ok = await this.post(batch);
      if (ok === "sent") {
        this.stats.sent += batch.length;
      } else if (ok === "retry") {
        // Nazad na početak reda samo ono što nije zastarelo; pokušava se u sledećem krugu.
        const fresh = batch.filter((q) => this.now() - q.queuedAt <= this.cfg.maxAgeMs);
        this.stats.dropped += batch.length - fresh.length;
        this.buffer.unshift(...fresh);
        if (this.buffer.length > 0) {
          this.timer ??= setTimeout(() => void this.flush(), this.cfg.flushMs).unref();
        }
        return;
      } else {
        this.stats.dropped += batch.length;
      }
    }
  }

  private take(): Queued[] {
    let n = 0;
    let bytes = 0;
    while (n < this.buffer.length && n < MAX_EVENTS) {
      const next = this.buffer[n]!.bytes + 1;
      if (n > 0 && bytes + next > MAX_ENVELOPE_BYTES) break;
      bytes += next;
      n++;
    }
    return this.buffer.splice(0, n);
  }

  /** `sent`, `retry` (mreža, 5xx) ili `drop` (4xx: ponavljanje ne bi pomoglo). */
  private async post(batch: Queued[]): Promise<"sent" | "retry" | "drop"> {
    const body =
      `{"v":1,"portal":${JSON.stringify(this.cfg.portal)},"sent_ms":${this.now()},` +
      `"events":[${batch.map((q) => q.json).join(",")}]}`;
    try {
      const res = await this.fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      await res.body?.cancel();
      if (res.ok) return "sent";
      return res.status >= 500 ? "retry" : "drop";
    } catch {
      return "retry";
    }
  }
}
