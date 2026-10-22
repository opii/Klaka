// Presude iz klaka-api (`/api/presude` na listener-u recenzenta) za pogled „Rendgen". Portal ih
// čita sa servera, pod svojim nalogom recenzenta (`PORTAL_REVIEW_AUTH`). To su razlozi presude,
// koje Valkey namerno nema (verdicts.md §2) — pravi portal ih ne prikazuje; ovde je to
// demonstracija, i isključuje se sa `PORTAL_XRAY=isključen`. Bez naloga ili kad klaka-api ne
// odgovori, Rendgen pokazuje samo ono što portal sam zna.

export interface NetVerdict {
  id: number;
  net: string;
  detectors: string;
  cohort: number | null;
  active: boolean;
  created: string;
  created_ms: number;
  roles: string | null;
  /** Poslednja odluka recenzenta: `confirm`, `reject`, ili `null` (nepregledana). */
  decision: string | null;
  /** Putanja presude u UI-ju recenzenta (`/presude/<id>`). */
  href: string;
}

const TIMEOUT_MS = 1_500;
const CHUNK = 400;

export class ReviewClient {
  private warned = false;

  constructor(
    private readonly base: string,
    private readonly auth: string,
    /** Adresa UI-ja recenzenta iz browsera (linkovi sa portala). */
    private readonly publicBase: string,
    private readonly portal: string,
  ) {}

  link(href: string): string {
    return this.publicBase.replace(/\/+$/, "") + href;
  }

  /** Poslednja presuda po prefiksu; prazno kad klaka-api nije dostupan. */
  async verdicts(nets: string[]): Promise<Map<string, NetVerdict>> {
    const out = new Map<string, NetVerdict>();
    const unique = [...new Set(nets)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const q = new URLSearchParams({ portal: this.portal, nets: unique.slice(i, i + CHUNK).join(",") });
      try {
        const res = await fetch(`${this.base.replace(/\/+$/, "")}/api/presude?${q}`, {
          headers: { Authorization: `Basic ${Buffer.from(this.auth).toString("base64")}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const v of (await res.json()) as NetVerdict[]) out.set(v.net, v);
      } catch (e) {
        if (!this.warned) console.warn(`presude iz klaka-api nedostupne: ${(e as Error).message}`);
        this.warned = true;
        return out;
      }
    }
    this.warned = false;
    return out;
  }
}
