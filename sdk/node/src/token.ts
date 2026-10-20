// Token pregleda — core/spec/token.md.
//
// Provera ide normativnim redosledom iz spec-a §4 i vraća prvi neuspeh, tako da svi SDK-ovi
// daju isti rezultat za isti ulaz (core/spec/test-vectors/token.json).

import { createPublicKey, verify, type KeyObject } from "node:crypto";

export type TokenResult =
  | "valid"
  | "missing"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_portal"
  | "wrong_post"
  | "too_young"
  | "expired"
  | "overused";

export interface Payload {
  v: 1;
  portal: string;
  post: string;
  vid: string;
  iat: number;
}

/** Pragovi provere. Nikad ne idu u token ni do browsera (spec README, princip 2). */
export interface Policy {
  minAgeMs: number;
  maxAgeMs: number;
  maxUses: number;
}

/**
 * Ishod koraka 1–10. `payload` postoji ako su koraci 1–5 prošli, čak i kad kasniji ne prođu —
 * tada se zna `vid` za brojač upotreba i za događaj.
 */
export interface Verification {
  result: TokenResult;
  payload: Payload | null;
}

export const MAX_TOKEN_LEN = 1024;

// Korak 2 (spec §4), doslovno.
const TOKEN_RE = /^ppd1\.([a-z0-9-]{1,32})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const VID_RE = /^[A-Za-z0-9_-]{22}$/;

// fatal: neispravan UTF-8 je greška, ne tiha zamena sa U+FFFD.
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class TokenVerifier {
  readonly #portal: string;
  readonly #keys: Map<string, KeyObject>;
  readonly #policy: Policy;

  /** `keys`: kid → javni ključ (base64url, 32 bajta). Neispravan ključ baca grešku odmah. */
  constructor(portal: string, keys: Record<string, string>, policy: Policy) {
    this.#portal = portal;
    this.#policy = { ...policy };
    this.#keys = new Map(Object.entries(keys).map(([kid, k]) => [kid, publicKeyFromB64u(kid, k)]));
    if (this.#keys.size === 0) throw new Error("ppd: nema nijednog javnog ključa u konfiguraciji");
  }

  get policy(): Readonly<Policy> {
    return this.#policy;
  }

  /** Koraci 1–9: sve što ne zavisi od stanja. */
  verify(token: string | null | undefined, post: string, nowMs: number): Verification {
    // 1
    if (token === null || token === undefined || token === "") return fail("missing");
    // 2
    if (token.length > MAX_TOKEN_LEN) return fail("malformed");
    const m = TOKEN_RE.exec(token);
    if (!m) return fail("malformed");
    const [, kid, payloadB64, sigB64] = m as unknown as [string, string, string, string];
    // 3
    const key = this.#keys.get(kid);
    if (!key) return fail("unknown_key");
    // 4 — potpis pre JSON-a
    const sig = decodeCanonical(sigB64);
    if (!sig || sig.length !== 64) return fail("bad_signature");
    const signed = Buffer.from(token.slice(0, token.length - sigB64.length - 1), "ascii");
    if (!verify(null, signed, key, sig)) return fail("bad_signature");
    // 5
    const payload = parsePayload(payloadB64);
    if (!payload) return fail("malformed");
    // 6–9
    const age = nowMs - payload.iat;
    let result: TokenResult = "valid";
    if (payload.portal !== this.#portal) result = "wrong_portal";
    else if (payload.post !== post) result = "wrong_post";
    else if (age < this.#policy.minAgeMs) result = "too_young";
    else if (age > this.#policy.maxAgeMs) result = "expired";
    return { result, payload };
  }

  /** Korak 10: `uses` = stanje brojača za `vid` posle ove akcije. Menja samo `valid`. */
  checkUses(v: Verification, uses: number): Verification {
    if (v.result === "valid" && uses > this.#policy.maxUses) return { ...v, result: "overused" };
    return v;
  }
}

function fail(result: TokenResult): Verification {
  return { result, payload: null };
}

/**
 * Strogo i kanonski (spec §4): samo base64url alfabet, bez paddinga, i ponovo kodirano mora
 * biti identično ulazu. Node-ov dekoder sam po sebi prihvata `AR` kao `AQ` — ovo to odbija.
 */
function decodeCanonical(s: string): Buffer | null {
  if (!B64URL_RE.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/** Korak 5: kanonski base64url → strogi UTF-8 → JSON objekat → polja ispravnog tipa. */
function parsePayload(b64: string): Payload | null {
  const bytes = decodeCanonical(b64);
  if (!bytes) return null;
  let p: unknown;
  try {
    p = JSON.parse(utf8.decode(bytes));
  } catch {
    return null;
  }
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  const ok =
    o.v === 1 &&
    typeof o.portal === "string" &&
    typeof o.post === "string" &&
    typeof o.vid === "string" &&
    VID_RE.test(o.vid) &&
    Number.isSafeInteger(o.iat);
  if (!ok) return null;
  return {
    v: 1,
    portal: o.portal as string,
    post: o.post as string,
    vid: o.vid as string,
    iat: o.iat as number,
  };
}

function publicKeyFromB64u(kid: string, b64: string): KeyObject {
  const raw = decodeCanonical(b64);
  if (!raw || raw.length !== 32) throw new Error(`ppd: javni ključ "${kid}" nije base64url od 32 bajta`);
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64 }, format: "jwk" });
}
