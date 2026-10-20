# Test vektori

| Fajl | Pokriva |
| --- | --- |
| `token.json` | provera tokena pregleda, [`../token.md`](../token.md) §4 — 33 slučaja |

Format `token.json`: `config` (javni ključevi i pragovi za test), `defaults` (portal, post,
`now_ms`, `uses`), i `cases[]` sa `input` (token + eventualne izmene podrazumevanih vrednosti)
i `expect` (rezultat).

Test ključ `test-1` je objavljen sa seed-om **samo za testove**. Ed25519 je deterministički,
pa `ppd-core` iz seed-a reprodukuje iste tokene; test u `ppd-core` biće kanonski generator
i proveravati da se fajl nije promenio.

Vektori su provereni dvema nezavisnim implementacijama (Node `crypto`, PHP `sodium`) pri
nastanku, 2026-10-20.
