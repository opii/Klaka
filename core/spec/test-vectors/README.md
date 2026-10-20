# Test vektori

| Fajl | Pokriva |
| --- | --- |
| `token.json` | provera tokena pregleda, [`../token.md`](../token.md) §4 — 34 slučaja |
| `net.json` | mrežni prefiks klijenta (IPv4 /24, IPv6 /48, mapirane adrese), [`../events.md`](../events.md) §3 — 25 slučajeva |
| `events.json` | pojedinačni događaji: šta collector prihvata i u kom obliku upisuje, [`../events.md`](../events.md) §2–§4 — 28 slučajeva |

Format `token.json`: `config` (javni ključevi i pragovi za test), `defaults` (portal, post,
`now_ms`, `uses`), i `cases[]` sa `input` (token + eventualne izmene podrazumevanih vrednosti)
i `expect` (rezultat).

Test ključ `test-1` je objavljen sa seed-om **samo za testove**. Ed25519 je deterministički,
pa `klaka-core` iz seed-a reprodukuje iste tokene; test u `klaka-core` biće kanonski generator
i proveravati da se fajl nije promenio.

Vektori su provereni dvema nezavisnim implementacijama (Node `crypto`, PHP `sodium`) pri
nastanku, 2026-10-20.
