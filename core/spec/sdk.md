# Ugovor SDK-a — v1

Šta svaki SDK (PHP, Node, Go, Java) MORA da radi isto. Implementacioni detalji (API po jeziku,
imena funkcija) su slobodni; ponašanje nije.

## 1. Javni API (koncept, ne potpis)

```
verifier = Klaka(config)
result   = verifier.onVote(request, post, target, dir)       → { decision }
result   = verifier.onComment(request, post, comment, author, text, replyTo)
verifier.onModeration(comment, result, reason)
verifier.onPost(post, rev, url, title, section, body)
```

`request` daje: token (zaglavlje `X-Klaka-Token` ili polje forme `klaka_token`), IP klijenta
(posle pouzdanog proxy-ja — konfiguracija), user-agent.

## 2. Tok jedne akcije (glas ili komentar)

```
1. token_result = verify(token, portal, post, now)              token.md §4, koraci 1–9
2. ako je token parsabilan (vid poznat):
       uses = INCR klaka:v1:<portal>:uses:<vid>  (Valkey; TTL = max_age_ms)
       ako uses > max_uses → token_result = overused             korak 10
3. action = najstroža presuda iz MGET ključeva                    verdicts.md §1
4. decision =
       "count"   ako token_result == valid i action == none
       "shadow"  inače
5. pošalji događaj (vote/comment) asinhrono                       events.md §3
6. vrati { decision } portalu
```

Portal: `count` → uračunaj u javni brojač; `shadow` → sačuvaj, prikaži samo izvoru, ne računaj.
Odgovor korisniku MORA biti isti u oba slučaja (spec README, princip 3).

### Otkazi — SDK nikad ne obara portal

| Kvar | Ponašanje |
| --- | --- |
| Valkey nedostupan (korak 2 ili 3) | `uses = null`, `action = none` → odluka samo po tokenu (**fail-open** za presude) |
| collector nedostupan (korak 5) | događaj se odbacuje posle kratkog bafera; akcija se ne blokira |
| greška u konfiguraciji (nema ključeva) | SDK se ne inicijalizuje — greška pri startu, ne pri zahtevu |

Fail-open za presude, ali **ne** za token: bez Valkey-ja nevažeći token i dalje daje `shadow`.
Token se proverava lokalno i ne zavisi ni od čega spolja.

Ukupni budžet koraka 2+3: **≤ 20 ms**; posle toga tretirati kao „Valkey nedostupan".
Korak 5 NE SME da blokira odgovor (PHP: slati posle `fastcgi_finish_request()` ili kroz lokalni
bafer; ostali: pozadinski red).

## 3. Konfiguracija

```json
{
  "portal": "demo.local",
  "keys": {"test-1": "<base64url javnog ključa, 32 bajta>"},
  "min_age_ms": 2000,
  "max_age_ms": 7200000,
  "max_uses": 50,
  "valkey_url": "redis://valkey:6379/0",
  "collector_url": "http://klaka-collector:8080",
  "api_key": "<portal_api_key>"
}
```

Vrednosti pragova iznad su **samo primer** — stvarne dolaze iz core-a po portalu i ne smeju
se objavljivati. Pragovi NE SMEJU stizati do browsera ni u kakvom obliku.

## 4. `cid` (opciono)

Ako portal već ima first-party ID posetioca (kolačić), SDK MOŽE da šalje
`cid = base64url(SHA-256(portal_salt ‖ id))[0..22]`. Bez `cid`-a sistem radi, samo slabije
povezuje istog posetioca kroz postove. Uključivanje traži pravnu proveru (ePrivacy) na strani
portala.

## 5. SDK NE SME

- da odbije ili blokira akciju (samo `count` / `shadow`);
- da korisniku vrati drugačiji odgovor ili kod zavisno od odluke;
- da šalje pun IP;
- da loguje token ili API ključ;
- da parsira JSON payload tokena pre provere potpisa.

## 6. Usklađenost

SDK je usklađen ako prolazi sve slučajeve iz [`test-vectors/token.json`](test-vectors/token.json)
(i budućih fajlova u `test-vectors/`) bez izuzetka.
