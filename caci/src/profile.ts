// Profil kampanje (docs/caci.md §5). Ova verzija ume nivoe 0–1 i uloge koje glasaju.

export type Level = 0 | 1;
export type Role = "amplifier" | "caci";
export type Side = "A" | "B";

export interface Profile {
  name: string;
  level: Level;
  /** Broj poslušnika po ulozi. */
  roles: Partial<Record<Role, number>>;
  /** Glasova po poslušniku. */
  votes: number;
  targets: { push: string[]; sink: string[] };
  /** Pusti i obrnutu kampanju (strana B), istog profila i jačine. */
  mirror: boolean;
  /** Prozor u kome poslušnici počinju (smena), sekunde. */
  window_s: number;
  /** Koliko /24 prefiksa deli kohorta jedne strane. */
  prefixes: number;
  /** Pauza između glasova jednog poslušnika. */
  delay_ms: LogNormal;
  /** Nivo 1: koliko čeka posle uzimanja tokena pre prvog glasa. */
  token_wait_ms: number;
  /** Nivo 1: nov token (nov prikaz) za svaki glas, uzet unapred — umesto jednog za ceo zadatak. */
  token_per_vote: boolean;
  audience: {
    readers: number;
    /** Vreme čitanja pre glasa. */
    read_ms: LogNormal;
    /** Verovatnoća da čitalac glasa. */
    vote_p: number;
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
  if (p.level !== 0 && p.level !== 1) fail("level: ova verzija ume 0 i 1");
  for (const [role, n] of Object.entries(p.roles ?? {})) {
    if (role !== "amplifier" && role !== "caci") fail(`roles: nepoznata uloga ${role}`);
    if (!Number.isInteger(n) || n < 0) fail(`roles.${role}`);
  }
  if (!Number.isInteger(p.votes) || p.votes < 1) fail("votes");
  if (!Array.isArray(p.targets?.push) || !Array.isArray(p.targets?.sink)) fail("targets.push / targets.sink");
  if ((p.roles.amplifier ?? 0) > 0 && p.targets.push.length === 0) fail("pojačivači traže targets.push");
  if ((p.roles.caci ?? 0) > 0 && p.targets.sink.length === 0) fail("ćaci traže targets.sink");
  if (!Number.isInteger(p.prefixes) || p.prefixes < 1) fail("prefixes");
  if (!(p.window_s >= 0)) fail("window_s");
  if (!(p.token_wait_ms >= 0)) fail("token_wait_ms");
  if (!(p.audience?.readers >= 0) || !(p.audience.vote_p >= 0 && p.audience.vote_p <= 1)) fail("audience");
  checkLogNormal(p.delay_ms, "delay_ms", fail);
  checkLogNormal(p.audience.read_ms, "audience.read_ms", fail);
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
