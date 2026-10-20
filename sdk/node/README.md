# @klaka/sdk-node

Klaka SDK za Node backend portala (proof of concept). Node 18+, TypeScript, **bez runtime
zavisnosti** — Ed25519 iz `node:crypto`. Ponašanje propisuje [`core/spec/`](../../core/spec/).

```ts
import { TokenVerifier, parseVerdict, strongest, decide } from "@klaka/sdk-node";

const verifier = new TokenVerifier("demo.local", { "dev-1": "<javni ključ, base64url>" }, {
  minAgeMs: 2_000, maxAgeMs: 7_200_000, maxUses: 50,   // primer; stvarni pragovi dolaze iz core-a
});

let v = verifier.verify(req.headers["x-klaka-token"], postId, Date.now());   // koraci 1–9
v = verifier.checkUses(v, uses);                                            // korak 10
const decision = decide(v.result, strongest([parseVerdict(raw, Date.now())])); // "count" | "shadow"
```

Portal korisniku vraća **isti odgovor** za `count` i `shadow` (spec README, princip 3).

| Gotovo | Sledi |
| --- | --- |
| provera tokena (34/34 zajedničkih vektora), presude, odluka | Valkey (brojač upotreba, `MGET` presuda), slanje događaja collector-u, `onVote` / `onComment` (`sdk.md` §1–§2) |

```bash
docker compose run --rm -w /work/sdk/node node npm test   # iz korena repoa
```
