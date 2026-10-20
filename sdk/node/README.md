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
```

Portal korisniku vraća **isti odgovor** za `count` i `shadow` (spec README, princip 3).

`onVote` radi ceo tok iz `sdk.md` §2: token, brojač upotreba prikaza, jedan glas po (`vid`,
cilj) (§2a), presude, odluka, pa događaj collector-u u pozadini. Valkey ima budžet od 20 ms;
ako ne odgovori ili ne postoji, odluka je samo po tokenu (fail-open za presude).

**Valkey** se daje kao `Store` sa tri operacije, da SDK ostane bez runtime zavisnosti.
Adapter za node-redis (ceo primer: [`demo/src/valkey.ts`](../../demo/src/valkey.ts)):

```ts
const client = createClient({ url, disableOfflineQueue: true });   // bez reda: kvar odmah pada
const store: Store = {
  incr: async (k, ttl) => Number((await client.multi().incr(k).pExpire(k, ttl, "NX").exec())[0]),
  setNx: async (k, ttl) => (await client.set(k, "1", { NX: true, PX: ttl })) === "OK",
  mget: (keys) => client.mGet(keys),
};
```

Delovi su dostupni i pojedinačno (`TokenVerifier`, `parseVerdict`, `strongest`, `decide`,
`EventSender`, `netPrefix`), za portale koji tok slažu sami. `MemoryStore` je za testove.

| Gotovo | Sledi |
| --- | --- |
| provera tokena (34/34 zajedničkih vektora), `onVote` sa Valkey-jem (upotrebe, ponovljen glas, presude), slanje događaja | `onComment`, `onModeration`, `onPost`, `onPromotion` (`sdk.md` §1) |

```bash
docker compose run --rm -w /work/sdk/node node npm test   # iz korena repoa
```
