// Adrese za simulaciju (docs/caci.md §6): 198.18.0.0/15, opseg rezervisan za testiranje
// (RFC 2544) — 512 prefiksa /24. Raspored po ulogama zna samo emulator.

export class Prefixes {
  private readonly free: number[];

  /**
   * `exclude`: prefiksi (`198.18.7.0/24`) koje ne treba koristiti — npr. oni sa važećom
   * presudom iz ranijeg izvođenja, da je novo izvođenje ne nasledi.
   */
  constructor(
    private readonly rand: () => number = Math.random,
    exclude: ReadonlySet<string> = new Set(),
  ) {
    this.free = Array.from({ length: 512 }, (_, i) => i).filter(
      (i) => !exclude.has(`198.${18 + (i >> 8)}.${i & 0xff}.0/24`),
    );
    for (let i = this.free.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [this.free[i], this.free[j]] = [this.free[j]!, this.free[i]!];
    }
  }

  /** Nov, do sada nekorišćen /24, kao `198.18.7` (bez poslednjeg okteta). */
  take(): string {
    const i = this.free.pop();
    if (i === undefined) throw new Error("nema više slobodnih /24 u 198.18.0.0/15");
    return `198.${18 + (i >> 8)}.${i & 0xff}`;
  }

  /** Adresa domaćina u datom /24. */
  host(prefix: string): string {
    return `${prefix}.${1 + Math.floor(this.rand() * 254)}`;
  }
}
