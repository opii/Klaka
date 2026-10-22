# @klaka/sdk-node

Klaka SDK za Node backend portala (proof of concept). Node 18+, TypeScript, **bez runtime
zavisnosti** — Ed25519 iz `node:crypto`. Ponašanje propisuje [`core/spec/`](../../core/spec/).

```ts
import { EventSender, Klaka } from "@klaka/sdk-node";

const klaka = new Klaka({
  portal: "demo.local",
  keys: { "dev-1": "<javni ključ, base64url>" },
  policy: { minAgeMs: 2_000, maxAgeMs: 7_200_000, maxUses: 50 },  // primer; stvarni pragovi dolaze iz core-a
  store,                                                           // Valkey, vidi ispod
  events: new EventSender({ portal: "demo.local", collectorUrl: "http://klaka-collector:8080", apiKey }),
});

const { decision } = await klaka.onVote(
  { token: req.headers["x-klaka-token"], ip: clientIp, ua: req.headers["user-agent"] },
  { post: postId, target: commentId, targetAuthor: author, dir },
);
if (decision === "count") score += dir;   // "shadow": sačuvaj, prikaži samo glasaču, ne računaj

// Komentar: ID pravi portal pre poziva; "shadow" komentar vidi samo njegov autor.
const c = await klaka.onComment(request, { post: postId, comment: id, author, text, replyTo: null });

// Naknadni shadow (sdk.md §2b), periodično, van putanje zahteva; cursor čuva portal.
const { cursor: next, actions } = await klaka.retro(cursor);
for (const a of actions) {
  if (a.kind === "comment") hideFromPublic(a.comment);          // autor ga i dalje vidi
  else uncountVote(a.vid, a.target);                             // jedan uračunat glas po (vid, cilj)
}

// Događaji bez odluke: objava ili izmena posta, promocija, odluka moderatora.
klaka.onPost({ post: postId, rev, url, title, section, body });   // body: javni tekst, opciono
klaka.onPromotion(postId, "push");                                // nalet posle push-a nije klaka
klaka.onModeration(commentId, "rejected", reason);                // oznake za evaluaciju
```

Portal korisniku vraća **isti odgovor** za `count` i `shadow` (spec README, princip 3).

Ako portal ima nalog ili sopstveni ID posetioca, prosleđuje `cid: cidOf(salt, id)` u zahtevu
(`sdk.md` §4): pun ID ne napušta portal, a SDK čita i presudu po `cid` ključu.

`onVote` radi ceo tok iz `sdk.md` §2: token, brojač upotreba prikaza, jedan glas po (`vid`,
cilj) (§2a), presude, odluka, pa događaj collector-u u pozadini. `onComment` je isti tok, bez
pravila jednog glasa po cilju. `retro` čita akcije koje je engine uz presudu poslao u naknadni
shadow (`verdicts.md` §5): ono što je kohorta uradila pre nego što je prepoznata. Valkey ima budžet od 20 ms;
ako ne odgovori ili ne postoji, odluka je samo po tokenu (fail-open za presude).

**Valkey** se daje kao `Store` sa tri operacije (i četvrtom, `range`, za naknadni shadow), da
SDK ostane bez runtime zavisnosti.
Adapter za node-redis (ceo primer: [`demo/src/valkey.ts`](../../demo/src/valkey.ts)):

```ts
const client = createClient({ url, disableOfflineQueue: true });   // bez reda: kvar odmah pada
const store: Store = {
  incr: async (k, ttl) => Number((await client.multi().incr(k).pExpire(k, ttl, "NX").exec())[0]),
  setNx: async (k, ttl) => (await client.set(k, "1", { NX: true, PX: ttl })) === "OK",
  mget: (keys) => client.mGet(keys),
  range: async (k, after, count) =>
    (await client.xRange(k, `(${after}`, "+", { COUNT: count })).map((e) => ({ id: e.id, fields: e.message })),
};
```

Delovi su dostupni i pojedinačno (`TokenVerifier`, `parseVerdict`, `strongest`, `decide`,
`EventSender`, `netPrefix`), za portale koji tok slažu sami. `MemoryStore` je za testove.

| Gotovo | Sledi |
| --- | --- |
| provera tokena (34/34 zajedničkih vektora), `onVote` i `onComment` sa Valkey-jem (upotrebe, ponovljen glas, presude), naknadni shadow (`retro`), `onPromotion`, `onPost`, `onModeration`, `cid` (`cidOf`, presuda po `cid` ključu), slanje događaja — ceo javni API iz `sdk.md` §1 | SDK-ovi za druge jezike (`sdk/php`, `sdk/go`, `sdk/java`) |

```bash
docker compose run --rm -w /work/sdk/node node npm test   # iz korena repoa
```
