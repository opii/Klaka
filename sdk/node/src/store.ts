// Valkey (Redis) iz ugla SDK-a: tri operacije iz sdk.md §2 i čitanje stream-a za naknadni
// shadow (§2b). SDK nema runtime zavisnosti, pa klijent daje portal — adapter za node-redis ili
// ioredis je nekoliko redova (vidi README).

/** Unos iz Valkey stream-a. */
export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface Store {
  /** INCR + PEXPIRE NX: brojač upotreba prikaza (korak 2). */
  incr(key: string, ttlMs: number): Promise<number>;
  /** SET key 1 NX PX ttl: `true` ako ključ nije postojao (sdk.md §2a). */
  setNx(key: string, ttlMs: number): Promise<boolean>;
  /** MGET: presude (korak 3, verdicts.md §1). */
  mget(keys: string[]): Promise<(string | null)[]>;
  /**
   * XRANGE key (after + COUNT n: najviše `count` unosa sa ID-jem većim od `after`. Bez nje
   * SDK nema naknadni shadow (sdk.md §2b) — ostalo radi isto.
   */
  range?(key: string, after: string, count: number): Promise<StreamEntry[]>;
}

/** Store u memoriji procesa — za testove i jedan proces bez Valkey-ja. */
export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: string; until: number }>();
  private readonly streams = new Map<string, StreamEntry[]>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async incr(key: string, ttlMs: number): Promise<number> {
    const cur = this.get(key);
    const n = (cur ? Number(cur.value) : 0) + 1;
    this.data.set(key, { value: String(n), until: cur?.until ?? this.now() + ttlMs });
    return n;
  }

  async setNx(key: string, ttlMs: number): Promise<boolean> {
    if (this.get(key)) return false;
    this.data.set(key, { value: "1", until: this.now() + ttlMs });
    return true;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.get(k)?.value ?? null);
  }

  async range(key: string, after: string, count: number): Promise<StreamEntry[]> {
    return (this.streams.get(key) ?? []).filter((e) => compareIds(e.id, after) > 0).slice(0, count);
  }

  /** Za testove: unos u stream (kao XADD sa `*`). */
  append(key: string, fields: Record<string, string>): string {
    const id = `${this.now()}-${this.seq++}`;
    const list = this.streams.get(key) ?? [];
    list.push({ id, fields });
    this.streams.set(key, list);
    return id;
  }

  /** Za testove: presuda ili bilo koja vrednost. */
  set(key: string, value: string, ttlMs: number): void {
    this.data.set(key, { value, until: this.now() + ttlMs });
  }

  private get(key: string): { value: string; until: number } | undefined {
    const e = this.data.get(key);
    if (e && e.until <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
}

/** Poređenje ID-jeva stream-a (`<ms>-<seq>`) kao brojeva. */
function compareIds(a: string, b: string): number {
  const [am, as] = a.split("-").map(BigInt);
  const [bm, bs] = b.split("-").map(BigInt);
  return am !== bm ? (am! < bm! ? -1 : 1) : as === bs ? 0 : (as ?? 0n) < (bs ?? 0n) ? -1 : 1;
}
