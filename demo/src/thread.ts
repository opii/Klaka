// Niti komentara: koren i odgovori, sortiranje i stranice. Odgovor ostaje uz roditelja; koren je
// komentar bez roditelja (ili čiji roditelj ovom posetiocu nije vidljiv — tuđ shadow).

import type { Comment } from "./db.js";

export type Sort = "najbolji" | "najnoviji";
export const SORTS: Sort[] = ["najbolji", "najnoviji"];

/** Niti po stranici: pravi portal ne učitava hiljade komentara odjednom. */
export const PAGE = 50;

export interface Thread {
  root: Comment;
  replies: Comment[];
}

/**
 * „Najbolji": koreni po zbiru (veći prvi), pa stariji; „najnoviji": noviji prvi. Odgovori uvek
 * hronološki. Zbir je onaj koji vidi posetilac — poslušnik vidi svoj gurnut komentar na vrhu.
 */
export function threads(list: Comment[], sort: Sort): Thread[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const replies = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of list) {
    if (c.reply_to && byId.has(c.reply_to)) {
      const root = rootOf(c, byId);
      const group = replies.get(root);
      if (group) group.push(c);
      else replies.set(root, [c]);
    } else {
      roots.push(c);
    }
  }
  roots.sort(sort === "najbolji" ? (a, b) => b.score - a.score || a.t - b.t : (a, b) => b.t - a.t);
  return roots.map((root) => ({ root, replies: (replies.get(root.id) ?? []).sort((a, b) => a.t - b.t) }));
}

/** Koren niti: odgovor na odgovor ide u nit prvog komentara. */
function rootOf(c: Comment, byId: Map<string, Comment>): string {
  let cur = c;
  for (let depth = 0; depth < 50 && cur.reply_to && byId.has(cur.reply_to); depth++) cur = byId.get(cur.reply_to)!;
  return cur.id;
}

/** Stranica (od 1) na kojoj je komentar `id`, ili 1 ako ga nema. */
export function pageOf(list: Thread[], id: string): number {
  const i = list.findIndex((t) => t.root.id === id || t.replies.some((r) => r.id === id));
  return i < 0 ? 1 : Math.floor(i / PAGE) + 1;
}
