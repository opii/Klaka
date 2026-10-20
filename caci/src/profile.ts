// Profil kampanje (docs/caci.md §5): nivoi 0–4, sve tri uloge, glasovi i komentari.

export type Level = 0 | 1 | 2 | 3 | 4;
export type Role = "amplifier" | "caci" | "diluter";
export type Side = "A" | "B";

export const ROLES: readonly Role[] = ["amplifier", "caci", "diluter"];

export interface Profile {
  name: string;
  level: Level;
  /** Broj poslušnika po ulozi. */
  roles: Partial<Record<Role, number>>;
  /**
   * Glasova po poslušniku. Pojačivači i ćaci glasaju za `push`, odnosno protiv `sink`;
   * razvodnjivači za komentare drugih razvodnjivača svoje strane.
   */
  votes: number;
  /** Komentara po poslušniku (šabloni uloge), izmešanih sa glasovima. */
  comments?: number;
  /**
   * `push` / `sink`: ID-jevi komentara koje kampanja gura, odnosno potiskuje (sa bilo kog
   * članka). `dilute`: članci koje razvodnjivači zatrpavaju; uloga nema stranu, pa u ogledalu
   * obe strane razvodnjavaju iste članke.
   */
  targets: { push: string[]; sink: string[]; dilute?: string[] };
  /** Pusti i obrnutu kampanju (strana B), istog profila i jačine. */
  mirror: boolean;
  /** Prozor u kome poslušnici počinju (smena), sekunde. */
  window_s: number;
  /** Koliko /24 prefiksa deli kohorta jedne strane. */
  prefixes: number;
  /** Pauza između akcija jednog poslušnika. */
  delay_ms: LogNormal;
  /** Nivo 1: koliko čeka posle uzimanja tokena pre prve akcije. */
  token_wait_ms: number;
  /** Nivo 1: nov token (nov prikaz) za svaku akciju, uzet unapred — umesto jednog po postu. */
  token_per_vote: boolean;
  /**
   * Nivoi 2–4 (pravi browser, svaka akcija = novo učitavanje stranice). Nivo 2: `click` — glas
   * klikom na dugme umesto `fetch`-a iz konzole; `hide_webdriver` — sakriva `navigator.webdriver`.
   * Nivoi 3–4 uvek klikću i sakrivaju, a pre klika skroluju do komentara i zadrže se `dwell_ms`.
   * Komentar: nivo 2 ga nalepi, nivoi 3–4 ga kucaju.
   */
  browser?: { click?: boolean; hide_webdriver?: boolean };
  dwell_ms?: LogNormal;
  /**
   * Nivo 4. `shifts`: poslušnici su raspoređeni u smene koje se smenjuju (`count` smena po
   * `duration_s`); `pseudonyms`: svaki poslušnik rotira ovoliko pseudonima; `paraphrase`:
   * svaki komentar je parafraza šablona (lokalni LLM), napravljena pre početka.
   */
  shifts?: { count: number; duration_s: number };
  pseudonyms?: number;
  paraphrase?: boolean;
  /** Šabloni po ulozi umesto generičkih (`texts.ts`). */
  templates?: Partial<Record<Role, string[]>>;
  audience: {
    readers: number;
    /** Legitimni blizanac: još ovoliko čitalaca, svi iza jednog prefiksa (CGNAT, firma). */
    cgnat?: number;
    /** Vreme čitanja pre glasa. */
    read_ms: LogNormal;
    /** Verovatnoća da čitalac glasa. */
    vote_p: number;
    /** Verovatnoća da čitalac napiše komentar na članak koji je pročitao. */
    comment_p?: number;
  };
}

export interface LogNormal {
  median: number;
  sigma: number;
}

export function parseProfile(raw: unknown): Profile {
  const p = raw as Profile;
  const fail = (msg: string): never => {
    throw new Error(`profil: ${msg}`);
  };
  if (typeof p !== "object" || p === null) fail("očekivan JSON objekat");
  if (typeof p.name !== "string" || !p.name) fail("name");
  if (![0, 1, 2, 3, 4].includes(p.level)) fail("level: 0–4");
  if (p.dwell_ms) checkLogNormal(p.dwell_ms, "dwell_ms", fail);
  for (const [role, n] of Object.entries(p.roles ?? {})) {
    if (!ROLES.includes(role as Role)) fail(`roles: nepoznata uloga ${role}`);
    if (!Number.isInteger(n) || n < 0) fail(`roles.${role}`);
  }
  if (!Number.isInteger(p.votes) || p.votes < 0) fail("votes");
  if (p.comments !== undefined && (!Number.isInteger(p.comments) || p.comments < 0)) fail("comments");
  if (!Array.isArray(p.targets?.push) || !Array.isArray(p.targets?.sink)) fail("targets.push / targets.sink");
  if ((p.roles.amplifier ?? 0) > 0 && p.targets.push.length === 0) fail("pojačivači traže targets.push");
  if ((p.roles.caci ?? 0) > 0 && p.targets.sink.length === 0) fail("ćaci traže targets.sink");
  if ((p.roles.diluter ?? 0) > 0 && !(p.targets.dilute?.length && (p.comments ?? 0) > 0)) {
    fail("razvodnjivači traže targets.dilute i comments > 0");
  }
  if (!Number.isInteger(p.prefixes) || p.prefixes < 1) fail("prefixes");
  if (!(p.window_s >= 0)) fail("window_s");
  if (!(p.token_wait_ms >= 0)) fail("token_wait_ms");
  if (p.shifts && !(Number.isInteger(p.shifts.count) && p.shifts.count >= 1 && p.shifts.duration_s > 0)) {
    fail("shifts: { count ≥ 1, duration_s > 0 }");
  }
  if (p.pseudonyms !== undefined && !(Number.isInteger(p.pseudonyms) && p.pseudonyms >= 1)) fail("pseudonyms");
  const a = p.audience;
  if (!(a?.readers >= 0) || !(a.vote_p >= 0 && a.vote_p <= 1)) fail("audience");
  if (a.comment_p !== undefined && !(a.comment_p >= 0 && a.comment_p <= 1)) fail("audience.comment_p");
  checkLogNormal(p.delay_ms, "delay_ms", fail);
  checkLogNormal(a.read_ms, "audience.read_ms", fail);
  return { ...p, mirror: p.mirror === true, token_per_vote: p.token_per_vote === true };
}

function checkLogNormal(d: LogNormal, name: string, fail: (m: string) => never): void {
  if (!(d?.median > 0) || !(d.sigma >= 0)) fail(`${name}: { median > 0, sigma ≥ 0 }`);
}

/** Uzorak iz log-normalne raspodele (Box–Muller). `rand` je za testove. */
export function sample(d: LogNormal, rand: () => number = Math.random): number {
  const u = 1 - rand();
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return d.median * Math.exp(d.sigma * z);
}

/** Redosled zadataka poslušnika: `comments` komentara ravnomerno među `votes` glasova. */
export function schedule(votes: number, comments: number): ("vote" | "comment")[] {
  const total = votes + comments;
  const out: ("vote" | "comment")[] = [];
  for (let i = 0; i < total; i++) {
    // Komentar na mestu i ako se broj komentara do i+1 (ravnomerno) povećao.
    const before = Math.floor((i * comments) / total);
    const after = Math.floor(((i + 1) * comments) / total);
    out.push(after > before ? "comment" : "vote");
  }
  return out;
}
