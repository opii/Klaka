// Ceo tok jedne akcije (sdk.md §2): token → stanje u Valkey-ju → odluka → događaj.

import { truncateUa, type EventSender } from "./events.js";
import { netPrefix } from "./net.js";
import type { Store, StreamEntry } from "./store.js";
import { TokenVerifier, type Policy, type TokenResult } from "./token.js";
import { decide, parseVerdict, strongest, type Action, type Decision } from "./verdict.js";

export interface KlakaConfig {
  portal: string;
  keys: Record<string, string>;
  policy: Policy;
  /** Bez njega: nema brojača upotreba, ponovljenih glasova ni presuda (kao Valkey nedostupan). */
  store?: Store;
  /** Bez njega se događaji ne šalju. */
  events?: EventSender;
  /** Budžet za Valkey (koraci 2+3); posle toga se tretira kao nedostupan. */
  budgetMs?: number;
  now?: () => number;
}

/** Ono što SDK treba iz HTTP zahteva; portal ga izvlači iz svog framework-a. */
export interface ClientRequest {
  /** Zaglavlje `X-Klaka-Token` ili polje forme `klaka_token`. */
  token: string | null | undefined;
  /** IP klijenta, posle pouzdanog proxy-ja. Ne napušta portal — dalje ide samo prefiks. */
  ip: string;
  ua: string | undefined;
}

export interface VoteInput {
  post: string;
  target: string;
  targetAuthor: string | null;
  dir: 1 | -1;
}

export interface VoteResult {
  decision: Decision;
  /** Iz tokena, ako je parsabilan (koraci 1–5). */
  vid: string | null;
  token: TokenResult;
  uses: number | null;
  repeat: boolean | null;
  action: Action;
}

export interface CommentInput {
  post: string;
  /** ID komentara u sistemu portala (portal ga pravi pre poziva). */
  comment: string;
  author: string;
  text: string;
  replyTo: string | null;
}

export type CommentResult = Omit<VoteResult, "repeat">;

/** Kanal kojim je portal sam promovisao post (events.md §3, `promotion`). */
export type PromotionChannel = "push" | "homepage" | "newsletter" | "social" | "other";

/** Objava ili izmena posta (events.md `post`). */
export interface PostInput {
  post: string;
  /** Revizija; raste pri svakoj izmeni. */
  rev: number;
  /** Kanonski URL. */
  url: string;
  title: string;
  /** Rubrika (za poređenje po temama). */
  section?: string | null;
  /** Javan tekst članka, ako ga portal šalje: engine meri koliko se komentari tiču članka. */
  body?: string | null;
}

export type ModerationResult = "approved" | "rejected";

/**
 * Akcija za naknadni shadow (verdicts.md §5): komentar se više ne prikazuje javno (autor ga i
 * dalje vidi), glas se oduzima od javnog zbira. Glas je određen parom (`vid`, `target`) — prikaz
 * ima najviše jedan uračunat glas po cilju (sdk.md §2a).
 */
export type RetroAction =
  | { kind: "comment"; post: string; comment: string }
  | { kind: "vote"; post: string; vid: string; target: string };

export interface RetroBatch {
  /** ID poslednjeg pročitanog unosa; sledeći poziv kreće od njega. */
  cursor: string;
  actions: RetroAction[];
}

interface State {
  uses: number | null;
  repeat: boolean | null;
  action: Action;
}

const UNAVAILABLE: State = { uses: null, repeat: null, action: "none" };

export class Klaka {
  #verifier: TokenVerifier;
  readonly #cfg: KlakaConfig;
  readonly #now: () => number;
  readonly #prefix: string;

  constructor(cfg: KlakaConfig) {
    this.#cfg = cfg;
    this.#verifier = new TokenVerifier(cfg.portal, cfg.keys, cfg.policy);
    this.#now = cfg.now ?? Date.now;
    this.#prefix = `klaka:v1:${cfg.portal}:`;
  }

  /** Rotacija ključeva bez novog objekta (token.md §6). */
  setKeys(keys: Record<string, string>): void {
    this.#verifier = new TokenVerifier(this.#cfg.portal, keys, this.#cfg.policy);
  }

  /**
   * Glas. Ne baca izuzetak zbog Valkey-ja ni collector-a. Portal korisniku vraća isti odgovor
   * za `count` i `shadow` (spec README, princip 3).
   */
  async onVote(req: ClientRequest, vote: VoteInput): Promise<VoteResult> {
    const now = this.#now();
    let v = this.#verifier.verify(req.token, vote.post, now);
    const vid = v.payload?.vid ?? null;
    const net = netPrefix(req.ip);

    const state = await this.#state(vid, vote.target, net);
    if (state.uses !== null) v = this.#verifier.checkUses(v, state.uses);
    const decision = state.repeat === true ? "shadow" : decide(v.result, state.action);

    if (this.#cfg.events && net) {
      this.#cfg.events.send({
        type: "vote", t: now, post: vote.post, vid, token: v.result, uses: state.uses, decision, net,
        ua: truncateUa(req.ua), target: vote.target, target_author: vote.targetAuthor, dir: vote.dir,
        repeat: state.repeat,
      });
    }
    return { decision, vid, token: v.result, uses: state.uses, repeat: state.repeat, action: state.action };
  }

  /**
   * Komentar: isti tok kao glas, bez pravila jednog glasa po cilju (§2a). `shadow` komentar
   * portal čuva i prikazuje samo autoru; odgovor je isti kao za `count`.
   */
  async onComment(req: ClientRequest, c: CommentInput): Promise<CommentResult> {
    const now = this.#now();
    let v = this.#verifier.verify(req.token, c.post, now);
    const vid = v.payload?.vid ?? null;
    const net = netPrefix(req.ip);

    const state = await this.#state(vid, null, net);
    if (state.uses !== null) v = this.#verifier.checkUses(v, state.uses);
    const decision = decide(v.result, state.action);

    if (this.#cfg.events && net) {
      this.#cfg.events.send({
        type: "comment", t: now, post: c.post, vid, token: v.result, uses: state.uses, decision, net,
        ua: truncateUa(req.ua), comment: c.comment, author: c.author, text: c.text, reply_to: c.replyTo,
      });
    }
    return { decision, vid, token: v.result, uses: state.uses, action: state.action };
  }

  /**
   * Portal je sam promovisao post (push, naslovna…): legitiman blizanac vremenske dimenzije —
   * nalet čitalaca posle promocije nije koordinacija (koncept §8). Samo događaj, bez odluke.
   */
  onPromotion(post: string, channel: PromotionChannel): void {
    this.#cfg.events?.send({ type: "promotion", t: this.#now(), post, channel });
  }

  /** Objava ili izmena posta (nova `rev`). Samo događaj, bez odluke. */
  onPost(p: PostInput): void {
    this.#cfg.events?.send({
      type: "post", t: this.#now(), post: p.post, rev: p.rev, url: p.url, title: p.title,
      section: p.section ?? null, body: p.body ?? null,
    });
  }

  /**
   * Odluka moderatora o komentaru — izvor oznaka za evaluaciju (koncept §6). Identitet
   * moderatora se ne šalje (events.md). Samo događaj, bez odluke.
   */
  onModeration(comment: string, result: ModerationResult, reason: string | null = null): void {
    this.#cfg.events?.send({ type: "moderation", t: this.#now(), comment, result, reason });
  }

  /**
   * Naknadni shadow (sdk.md §2b): akcije posle `after`. Portal ga zove periodično, van putanje
   * zahteva, primenjuje akcije idempotentno i čuva `cursor`. Neispravan unos se preskače;
   * Valkey nedostupan → prazan spisak i isti `cursor`.
   */
  async retro(after = "0-0", count = 100): Promise<RetroBatch> {
    const store = this.#cfg.store;
    if (!store?.range) return { cursor: after, actions: [] };
    let entries: StreamEntry[];
    try {
      entries = await store.range(`${this.#prefix}retro`, after, count);
    } catch {
      return { cursor: after, actions: [] };
    }
    const actions = entries.map((e) => parseRetro(e.fields)).filter((a): a is RetroAction => a !== null);
    return { cursor: entries.at(-1)?.id ?? after, actions };
  }

  /**
   * Koraci 2–3 u jednom krugu do Valkey-ja, u budžetu; svaki kvar je „nedostupan" (fail-open).
   * `target` samo za glas (ponovljen glas, §2a).
   */
  async #state(vid: string | null, target: string | null, net: string | null): Promise<State> {
    const store = this.#cfg.store;
    if (!store) return UNAVAILABLE;
    const ttl = this.#verifier.policy.maxAgeMs;
    const verdictKeys = [net && `${this.#prefix}net:${net}`, vid && `${this.#prefix}vid:${vid}`].filter(
      (k): k is string => !!k,
    );
    const work = Promise.all([
      vid ? store.incr(`${this.#prefix}uses:${vid}`, ttl) : null,
      vid && target !== null ? store.setNx(`${this.#prefix}voted:${vid}:${target}`, ttl) : null,
      verdictKeys.length ? store.mget(verdictKeys) : [],
    ]).then(([uses, first, verdicts]): State => {
      const now = this.#now();
      return {
        uses,
        repeat: first === null ? null : !first,
        action: strongest(verdicts.map((raw) => parseVerdict(raw, now))),
      };
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<State>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), this.#cfg.budgetMs ?? 20);
    });
    try {
      return await Promise.race([work.catch(() => UNAVAILABLE), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRetro(f: Record<string, string>): RetroAction | null {
  const ok = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;
  if (!ok(f.post)) return null;
  if (f.kind === "comment" && ok(f.comment)) return { kind: "comment", post: f.post, comment: f.comment };
  if (f.kind === "vote" && ok(f.vid) && ok(f.target)) return { kind: "vote", post: f.post, vid: f.vid, target: f.target };
  return null;
}
