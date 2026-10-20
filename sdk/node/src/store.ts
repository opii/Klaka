// Valkey (Redis) iz ugla SDK-a: tri operacije iz sdk.md §2. SDK nema runtime zavisnosti, pa
// klijent daje portal — adapter za node-redis ili ioredis je nekoliko redova (vidi README).

export interface Store {
  /** INCR + PEXPIRE NX: brojač upotreba prikaza (korak 2). */
  incr(key: string, ttlMs: number): Promise<number>;
  /** SET key 1 NX PX ttl: `true` ako ključ nije postojao (sdk.md §2a). */
  setNx(key: string, ttlMs: number): Promise<boolean>;
  /** MGET: presude (korak 3, verdicts.md §1). */
  mget(keys: string[]): Promise<(string | null)[]>;
}

/** Store u memoriji procesa — za testove i jedan proces bez Valkey-ja. */
export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: string; until: number }>();

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
