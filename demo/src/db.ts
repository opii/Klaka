// Baza portala (PostgreSQL, baza `portal`, odvojena od Klakine): članci, komentari, glasovi,
// stanje. Pri startu napravi bazu ako ne postoji, primeni migracije (migrations/*.sql) i upiše
// početne članke i komentare.

import { readdirSync, readFileSync } from "node:fs";

import pg from "pg";

import type { Post, SeedComment } from "./content.js";

export type Decision = "count" | "shadow";

export interface Comment {
  id: string;
  post: string;
  reply_to: string | null;
  author: string;
  text: string;
  /** Javni brojač: samo glasovi sa odlukom `count`. */
  score: number;
  t: number;
  /** `shadow` komentar vidi samo autor (`owner`); javno se ne prikazuje. */
  decision: Decision;
  /** Kolačić posetioca koji je napisao komentar; `null` za početne komentare. */
  owner: string | null;
  /** Rezultat provere tokena; `null` za početne komentare. */
  token: string | null;
  /** Prebačen u shadow naknadno (verdicts.md §5), posle odluke `count`. */
  retro: boolean;
  /** Nalog autora; `null` za anonimni komentar (pseudonim uz komentar). */
  account: number | null;
  /** Mrežni prefiks autora (/24, /48); `null` za početne i stare komentare. */
  net: string | null;
}

/** Glasovi za komentar po odluci (pogledi „Poslušnik" i „Rendgen"). */
export interface VoteStats {
  /** Uračunati (javni zbir). */
  count: number;
  /** U shadow-u u trenutku glasa: broj i zbir smerova. */
  shadow: number;
  shadowSum: number;
  /** Uračunati, pa naknadno skinuti posle presude. */
  retro: number;
  retroSum: number;
}

/** Ko gleda: kolačić sesije i nalog, ako je prijavljen. */
export interface Viewer {
  sid: string | null;
  account: number | null;
}

export interface Account {
  id: number;
  pseudonym: string;
}

export interface Vote {
  t: number;
  /** Kolačić posetioca koji je glasao — njemu se shadow glas prikazuje kao uračunat. */
  owner: string | null;
  post: string;
  comment: string;
  dir: 1 | -1;
  vid: string | null;
  token: string;
  uses: number | null;
  repeat: boolean | null;
  decision: Decision;
  retro: boolean;
  account: number | null;
  net: string | null;
}

/** Uvezena vest pred objavu (src/ingest.ts); ID dodeljuje baza. */
export interface Imported {
  section: string;
  title: string;
  lead: string;
  paragraphs: string[];
  source: { name: string; url: string };
  toxicity: number;
  published_ms: number;
}

/** Red dnevnika uvoza: šta je urađeno sa vešću sa date adrese. */
export interface IngestEntry {
  url: string;
  t: number;
  source: string;
  /** Naslov kod izvora. */
  title: string;
  /** `accepted` objavljena, `rejected` odbio urednik, `skipped` predfilter, `error` ponovo sledeći put. */
  outcome: "accepted" | "rejected" | "skipped" | "error";
  reason: string | null;
  toxicity: number | null;
  post: string | null;
}

const MIGRATIONS = new URL("../migrations/", import.meta.url);

export class Db {
  private constructor(readonly pool: pg.Pool) {}

  /** Konekcija na bazu iz `url`; bazu pravi ako ne postoji, pa primeni migracije. */
  static async open(url: string): Promise<Db> {
    await ensureDatabase(url);
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = new Db(pool);
    await db.migrate();
    return db;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('portal_migrations'))");
      await client.query("CREATE TABLE IF NOT EXISTS portal_migrations (name text PRIMARY KEY)");
      const done = new Set((await client.query<{ name: string }>("SELECT name FROM portal_migrations")).rows.map((r) => r.name));
      for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(name)) continue;
        await client.query("BEGIN");
        await client.query(readFileSync(new URL(name, MIGRATIONS), "utf8"));
        await client.query("INSERT INTO portal_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`portal: migracija ${name}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('portal_migrations'))").catch(() => {});
      client.release();
    }
  }

  /** Početni komentari (idempotentno): roditelj pre odgovora, vreme pre svih pravih komentara. */
  async seed(comments: SeedComment[], t: number): Promise<void> {
    const ordered = [...comments.filter((c) => !c.reply_to), ...comments.filter((c) => c.reply_to)];
    for (const [i, c] of ordered.entries()) {
      await this.pool.query(
        `INSERT INTO comments (id, post, reply_to, author, text, t, decision, seed)
         VALUES ($1, $2, $3, $4, $5, $6, 'count', true) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.post, c.reply_to ?? null, c.author, c.text, t + i],
      );
    }
  }

  /**
   * Članci iz repoa (idempotentno: postojeći red ostaje kakav je). Objava prvog je `t`, svaki
   * sledeći minut kasnije — redosled kao po ID-ju.
   */
  async seedPosts(posts: Post[], t: number): Promise<void> {
    for (const [i, p] of posts.entries()) {
      await this.pool.query(
        `INSERT INTO posts (id, section, title, lead, paragraphs, published_ms) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.section, p.title, p.lead ?? null, JSON.stringify(p.paragraphs), t + i * 60_000],
      );
    }
  }

  /** Članci, noviji prvi; `section` za jednu rubriku. */
  async posts(section?: string): Promise<Post[]> {
    const r = await this.pool.query(
      `SELECT ${POST} FROM posts WHERE ($1::text IS NULL OR section = $1) ORDER BY published_ms DESC, id DESC`,
      [section ?? null],
    );
    return r.rows.map(toPost);
  }

  async post(id: string): Promise<Post | null> {
    const r = await this.pool.query(`SELECT ${POST} FROM posts WHERE id = $1`, [id]);
    return r.rows[0] ? toPost(r.rows[0]) : null;
  }

  /** Članci za koje Klaka još nije dobila `onPost`, stariji prvi. */
  async unannouncedPosts(): Promise<Post[]> {
    const r = await this.pool.query(`SELECT ${POST} FROM posts WHERE NOT announced ORDER BY published_ms, id`);
    return r.rows.map(toPost);
  }

  async markAnnounced(id: string): Promise<void> {
    await this.pool.query("UPDATE posts SET announced = true WHERE id = $1", [id]);
  }

  // --- uvoz vesti -----------------------------------------------------------------------------

  /** Adrese koje uvoz preskače: već objavljene ili viđene (osim grešaka, one se ponavljaju). */
  async seenUrls(urls: string[]): Promise<Set<string>> {
    const r = await this.pool.query<{ url: string }>(
      `SELECT source_url AS url FROM posts WHERE source_url = ANY($1)
       UNION SELECT url FROM ingested_urls WHERE url = ANY($1) AND outcome <> 'error'`,
      [urls],
    );
    return new Set(r.rows.map((x) => x.url));
  }

  /** Objava uvezene vesti (ID iz `post_seq`) i zapis u dnevnik; `null` ako je adresa već objavljena. */
  async insertImported(p: Imported, entry: Omit<IngestEntry, "outcome" | "post">): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ id: string }>(
        `INSERT INTO posts (id, section, title, lead, paragraphs, source_name, source_url, toxicity, published_ms)
         VALUES ('p-' || nextval('post_seq'), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (source_url) DO NOTHING RETURNING id`,
        [p.section, p.title, p.lead, JSON.stringify(p.paragraphs), p.source.name, p.source.url, p.toxicity, p.published_ms],
      );
      const id = r.rows[0]?.id ?? null;
      if (id) await recordIngest(client, { ...entry, outcome: "accepted", post: id });
      await client.query("COMMIT");
      return id;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async recordIngest(e: IngestEntry): Promise<void> {
    await recordIngest(this.pool, e);
  }

  async nextCommentId(): Promise<string> {
    const r = await this.pool.query<{ n: string }>("SELECT nextval('comment_seq') AS n");
    return `c${r.rows[0]!.n}`;
  }

  async insertComment(c: Comment): Promise<void> {
    await this.pool.query(
      `INSERT INTO comments (id, post, reply_to, author, text, t, decision, owner, token, account, net)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [c.id, c.post, c.reply_to, c.author, c.text, c.t, c.decision, c.owner, c.token, c.account, c.net],
    );
  }

  async comment(id: string): Promise<Comment | null> {
    const r = await this.pool.query(`SELECT ${COMMENT} FROM comments WHERE id = $1`, [id]);
    return r.rows[0] ? toComment(r.rows[0]) : null;
  }

  /**
   * Komentari posta koje posetilac vidi: javni i njegovi shadow — sa ovog uređaja (kolačić) i,
   * ako je prijavljen, sa naloga (null post = svi postovi).
   */
  async visibleComments(post: string | null, viewer: Viewer): Promise<Comment[]> {
    const r = await this.pool.query(
      `SELECT ${COMMENT} FROM comments
       WHERE ($1::text IS NULL OR post = $1) AND (decision = 'count' OR owner = $2 OR account = $3)
       ORDER BY t, id`,
      [post, viewer.sid, viewer.account],
    );
    return r.rows.map(toComment);
  }

  /** Svi komentari posta, i tuđi shadow — samo za poglede „Poslušnik" i „Rendgen". */
  async allComments(post: string): Promise<Comment[]> {
    const r = await this.pool.query(`SELECT ${COMMENT} FROM comments WHERE post = $1 ORDER BY t, id`, [post]);
    return r.rows.map(toComment);
  }

  /** Glasovi po komentaru posta, po odluci. */
  async voteStats(post: string): Promise<Map<string, VoteStats>> {
    const r = await this.pool.query<{ comment: string; decision: Decision; retro: boolean; n: string; d: string }>(
      `SELECT comment, decision, retro, count(*) AS n, sum(dir) AS d FROM votes WHERE post = $1
       GROUP BY 1, 2, 3`,
      [post],
    );
    const out = new Map<string, VoteStats>();
    for (const x of r.rows) {
      const s = out.get(x.comment) ?? { count: 0, shadow: 0, shadowSum: 0, retro: 0, retroSum: 0 };
      if (x.decision === "count") s.count += Number(x.n);
      else if (x.retro) {
        s.retro += Number(x.n);
        s.retroSum += Number(x.d);
      } else {
        s.shadow += Number(x.n);
        s.shadowSum += Number(x.d);
      }
      out.set(x.comment, s);
    }
    return out;
  }

  /** Glasovi po (komentar, prefiks) — koliko je glasova stiglo iz prefiksa sa presudom. */
  async voteNets(post: string): Promise<{ comment: string; net: string; n: number }[]> {
    const r = await this.pool.query<{ comment: string; net: string; n: string }>(
      "SELECT comment, net, count(*) AS n FROM votes WHERE post = $1 AND net IS NOT NULL GROUP BY 1, 2",
      [post],
    );
    return r.rows.map((x) => ({ ...x, n: Number(x.n) }));
  }

  /** Prva akcija svakog prefiksa na postu (ms): presuda pre nje ne govori o ovom članku. */
  async netsFirstSeen(post: string): Promise<Map<string, number>> {
    const r = await this.pool.query<{ net: string; t: string }>(
      `SELECT net, min(t) AS t FROM (
           SELECT net, t FROM votes WHERE post = $1 AND net IS NOT NULL
           UNION ALL SELECT net, t FROM comments WHERE post = $1 AND net IS NOT NULL
       ) x GROUP BY net`,
      [post],
    );
    return new Map(r.rows.map((x) => [x.net, Number(x.t)]));
  }

  /** Javni komentari po postu (za naslovnu i rubrike). */
  async publicCounts(): Promise<Map<string, number>> {
    const r = await this.pool.query<{ post: string; n: string }>(
      "SELECT post, count(*) AS n FROM comments WHERE decision = 'count' GROUP BY post",
    );
    return new Map(r.rows.map((x) => [x.post, Number(x.n)]));
  }

  /** Shadow glasovi posetioca po komentaru: njemu se zbir prikazuje sa njima (sdk.md §2). */
  async ownShadowDeltas(viewer: Viewer, post: string | null): Promise<Map<string, number>> {
    const r = await this.pool.query<{ comment: string; d: string }>(
      `SELECT comment, sum(dir) AS d FROM votes
       WHERE (owner = $1 OR account = $3) AND decision = 'shadow' AND ($2::text IS NULL OR post = $2)
       GROUP BY comment`,
      [viewer.sid, post, viewer.account],
    );
    return new Map(r.rows.map((x) => [x.comment, Number(x.d)]));
  }

  /** Glas; uračunat glas odmah ide u javni zbir komentara. */
  async insertVote(v: Vote): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO votes (t, owner, post, comment, dir, vid, token, uses, repeat, decision, account, net)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [v.t, v.owner, v.post, v.comment, v.dir, v.vid, v.token, v.uses, v.repeat, v.decision, v.account, v.net],
      );
      if (v.decision === "count") {
        await client.query("UPDATE comments SET score = score + $2 WHERE id = $1", [v.comment, v.dir]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Naknadni shadow komentara (idempotentno). */
  async retroComment(id: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE comments SET decision = 'shadow', retro = true WHERE id = $1 AND decision = 'count'",
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Naknadni shadow glasa (vid, cilj), uz oduzimanje od javnog zbira (idempotentno). */
  async retroVote(vid: string, target: string): Promise<boolean> {
    const r = await this.pool.query(
      `WITH v AS (
           UPDATE votes SET decision = 'shadow', retro = true
           WHERE id = (SELECT id FROM votes WHERE vid = $1 AND comment = $2 AND decision = 'count'
                       ORDER BY t LIMIT 1)
           RETURNING comment, dir
       )
       UPDATE comments c SET score = c.score - v.dir FROM v WHERE c.id = v.comment`,
      [vid, target],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async lastVotes(limit: number): Promise<Vote[]> {
    const r = await this.pool.query(
      `SELECT * FROM (SELECT t, owner, post, comment, dir, vid, token, uses, repeat, decision, retro, account, net
                      FROM votes ORDER BY id DESC LIMIT $1) x ORDER BY t`,
      [limit],
    );
    return r.rows.map(
      (x) => ({ ...x, t: Number(x.t), dir: x.dir === -1 ? -1 : 1, account: x.account === null ? null : Number(x.account) }) as Vote,
    );
  }

  async lastComments(limit: number): Promise<Comment[]> {
    const r = await this.pool.query(
      `SELECT * FROM (SELECT ${COMMENT} FROM comments ORDER BY t DESC, id DESC LIMIT $1) x ORDER BY t, id`,
      [limit],
    );
    return r.rows.map(toComment);
  }

  // --- nalozi i sesije ------------------------------------------------------------------------

  /** Nov nalog; `null` ako je pseudonim zauzet (bez obzira na velika slova). */
  async createAccount(pseudonym: string, passwordHash: string): Promise<Account | null> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO accounts (pseudonym, pseudonym_key, password) VALUES ($1, lower($1), $2)
       ON CONFLICT (pseudonym_key) DO NOTHING RETURNING id`,
      [pseudonym, passwordHash],
    );
    return r.rows[0] ? { id: Number(r.rows[0].id), pseudonym } : null;
  }

  /** Nalog i zapis lozinke po pseudonimu (za proveru lozinke). */
  async accountByPseudonym(pseudonym: string): Promise<(Account & { password: string }) | null> {
    const r = await this.pool.query<{ id: string; pseudonym: string; password: string }>(
      "SELECT id, pseudonym, password FROM accounts WHERE pseudonym_key = lower($1)",
      [pseudonym],
    );
    const a = r.rows[0];
    return a ? { id: Number(a.id), pseudonym: a.pseudonym, password: a.password } : null;
  }

  async pseudonymTaken(pseudonym: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM accounts WHERE pseudonym_key = lower($1)", [pseudonym]);
    return (r.rowCount ?? 0) > 0;
  }

  async accountOfSession(sid: string): Promise<Account | null> {
    const r = await this.pool.query<{ id: string; pseudonym: string }>(
      "SELECT a.id, a.pseudonym FROM sessions s JOIN accounts a ON a.id = s.account WHERE s.sid = $1",
      [sid],
    );
    const a = r.rows[0];
    return a ? { id: Number(a.id), pseudonym: a.pseudonym } : null;
  }

  /**
   * Prijava: nova sesija pod novim kolačićem (zaštita od fiksiranja sesije). Anonimne akcije sa
   * starog kolačića prelaze na novi, pa autor i dalje vidi svoje shadow komentare i glasove.
   */
  async startSession(oldSid: string | null, newSid: string, account: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO sessions (sid, account) VALUES ($1, $2)", [newSid, account]);
      if (oldSid) {
        await client.query("UPDATE comments SET owner = $2 WHERE owner = $1", [oldSid, newSid]);
        await client.query("UPDATE votes SET owner = $2 WHERE owner = $1", [oldSid, newSid]);
        await client.query("DELETE FROM sessions WHERE sid = $1", [oldSid]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async endSession(sid: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE sid = $1", [sid]);
  }

  async getState(key: string): Promise<string | null> {
    const r = await this.pool.query<{ value: string }>("SELECT value FROM state WHERE key = $1", [key]);
    return r.rows[0]?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, value],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const COMMENT = "id, post, reply_to, author, text, score, t, decision, owner, token, retro, account, net";
const POST = "id, section, title, lead, paragraphs, source_name, source_url, published_ms";

function toPost(r: Record<string, unknown>): Post {
  const { id, section, title, lead, paragraphs, source_name, source_url, published_ms } = r as {
    id: string; section: string; title: string; lead: string | null; paragraphs: string[];
    source_name: string | null; source_url: string | null; published_ms: string;
  };
  return {
    id, section, title, paragraphs, published_ms: Number(published_ms),
    ...(lead !== null ? { lead } : {}),
    ...(source_name && source_url ? { source: { name: source_name, url: source_url } } : {}),
  };
}

/** Upis u dnevnik uvoza; ponovljena adresa (posle greške) dobija novi ishod. */
async function recordIngest(q: pg.Pool | pg.PoolClient, e: IngestEntry): Promise<void> {
  await q.query(
    `INSERT INTO ingested_urls (url, t, source, title, outcome, reason, toxicity, post)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (url) DO UPDATE SET t = $2, source = $3, title = $4, outcome = $5, reason = $6, toxicity = $7, post = $8`,
    [e.url, e.t, e.source, e.title, e.outcome, e.reason, e.toxicity, e.post],
  );
}

function toComment(r: Record<string, unknown>): Comment {
  return { ...(r as unknown as Comment), t: Number(r.t), account: r.account === null ? null : Number(r.account) };
}

/** Pravi bazu iz `url` ako ne postoji (konekcijom na `postgres` istog servera). */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== "3D000") throw e; // 3D000: baza ne postoji
  } finally {
    await probe.end().catch(() => {});
  }
  target.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    console.log(`portal: napravljena baza ${name}`);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P04") throw e; // već postoji (drugi proces)
  } finally {
    await admin.end();
  }
}
