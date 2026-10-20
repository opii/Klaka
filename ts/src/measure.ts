// Čiste funkcije: šta se o stranici i čitanju sme poslati (core/spec/events.md §2).
// Sve što bi bilo otisak uređaja ili lični podatak je ovde namerno grubo ili izostavljeno.

/** Referer → origin + putanja, bez query-ja i fragmenta; prazan ili neispravan → `null`. */
export function referrer(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

/** Veličina viewport-a zaokružena na 100 px. */
export function viewport(w: number, h: number): [number, number] {
  return [Math.round(w / 100) * 100, Math.round(h / 100) * 100];
}

/** Dubina stranice u promilima (0–1000) za tačku na visini `y` od vrha dokumenta. */
export function depth(y: number, docHeight: number): number {
  if (docHeight <= 0) return 0;
  return Math.max(0, Math.min(1000, Math.round((1000 * y) / docHeight)));
}

/** Indeks desetine (0–9) za dubinu u promilima. */
export function decile(d: number): number {
  return Math.min(9, Math.floor(d / 100));
}

export type Keys = "0" | "1-10" | "11-50" | "51-200" | "200+";
export type Pasted = "0" | "1-50" | "51-200" | "200+";
export type Length = "0" | "1-50" | "51-200" | "201-1000" | "1000+";

export function keysBucket(n: number): Keys {
  return n === 0 ? "0" : n <= 10 ? "1-10" : n <= 50 ? "11-50" : n <= 200 ? "51-200" : "200+";
}

export function pastedBucket(n: number): Pasted {
  return n === 0 ? "0" : n <= 50 ? "1-50" : n <= 200 ? "51-200" : "200+";
}

export function lengthBucket(n: number): Length {
  return n === 0 ? "0" : n <= 50 ? "1-50" : n <= 200 ? "51-200" : n <= 1000 ? "201-1000" : "1000+";
}
