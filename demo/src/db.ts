// Baza portala (PostgreSQL, baza `portal`, odvojena od Klakine): komentari, glasovi, stanje.
// Pri startu napravi bazu ako ne postoji, primeni migracije (migrations/*.sql) i upiše početne
// komentare.

import { readdirSync, readFileSync } from "node:fs";

import pg from "pg";

import type { SeedComment } from "./content.js";

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

  async nextCommentId(): Promise<string> {
    const r = await this.pool.query<{ n: string }>("SELECT nextval('comment_seq') AS n");
    return `c${r.rows[0]!.n}`;
  }

  async insertComment(c: Comment): Promise<void> {
    await this.pool.query(
      `INSERT INTO comments (id, post, reply_to, author, text, t, decision, owner, token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [c.id, c.post, c.reply_to, c.author, c.text, c.t, c.decision, c.owner, c.token],
    );
  }

  async comment(id: string): Promise<Comment | null> {
    const r = await this.pool.query(`SELECT ${COMMENT} FROM comments WHERE id = $1`, [id]);
    return r.rows[0] ? toComment(r.rows[0]) : null;
  }

  /** Komentari posta koje posetilac `sid` vidi: javni i njegovi shadow (null = svi posti). */
  async visibleComments(post: string | null, sid: string | null): Promise<Comment[]> {
    const r = await this.pool.query(
      `SELECT ${COMMENT} FROM comments
       WHERE ($1::text IS NULL OR post = $1) AND (decision = 'count' OR owner = $2)
       ORDER BY t, id`,
      [post, sid],
    );
    return r.rows.map(toComment);
  }

  /** Javni komentari po postu (za naslovnu i rubrike). */
  async publicCounts(): Promise<Map<string, number>> {
    const r = await this.pool.query<{ post: string; n: string }>(
      "SELECT post, count(*) AS n FROM comments WHERE decision = 'count' GROUP BY post",
    );
    return new Map(r.rows.map((x) => [x.post, Number(x.n)]));
  }

  /** Shadow glasovi posetioca po komentaru: njemu se zbir prikazuje sa njima (sdk.md §2). */
  async ownShadowDeltas(sid: string, post: string | null): Promise<Map<string, number>> {
    const r = await this.pool.query<{ comment: string; d: string }>(
      `SELECT comment, sum(dir) AS d FROM votes
       WHERE owner = $1 AND decision = 'shadow' AND ($2::text IS NULL OR post = $2)
       GROUP BY comment`,
      [sid, post],
    );
    return new Map(r.rows.map((x) => [x.comment, Number(x.d)]));
  }

  /** Glas; uračunat glas odmah ide u javni zbir komentara. */
  async insertVote(v: Vote): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO votes (t, owner, post, comment, dir, vid, token, uses, repeat, decision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [v.t, v.owner, v.post, v.comment, v.dir, v.vid, v.token, v.uses, v.repeat, v.decision],
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
      `SELECT * FROM (SELECT t, owner, post, comment, dir, vid, token, uses, repeat, decision, retro
                      FROM votes ORDER BY id DESC LIMIT $1) x ORDER BY t`,
      [limit],
    );
    return r.rows.map((x) => ({ ...x, t: Number(x.t), dir: x.dir === -1 ? -1 : 1 }) as Vote);
  }

  async lastComments(limit: number): Promise<Comment[]> {
    const r = await this.pool.query(
      `SELECT * FROM (SELECT ${COMMENT} FROM comments ORDER BY t DESC, id DESC LIMIT $1) x ORDER BY t, id`,
      [limit],
    );
    return r.rows.map(toComment);
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

const COMMENT = "id, post, reply_to, author, text, score, t, decision, owner, token, retro";

function toComment(r: Record<string, unknown>): Comment {
  return { ...(r as unknown as Comment), t: Number(r.t) };
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
