# Token pregleda — v1

Token dokazuje da je pre akcije (glas, komentar) postojao **stvaran prikaz tog posta**, i
kada. Izdaje ga `ppd-api`, proverava SDK na backendu portala.

## 1. Zašto ne JWT

JWT/JWS bi radio, ali: (a) zaglavlje `alg` je istorijski izvor napada (alg confusion,
`none`); (b) za proveru bez zavisnosti u PHP/Go/Java/Node ionako pišemo svoj kod. Ovde je
algoritam **fiksiran verzijom** (`ppd1` = Ed25519) i format ima četiri polja koja se mogu
proveriti regex-om pre bilo kakvog dekodiranja.

Ed25519 a ne HMAC: portal ima **samo javni ključ** — provala portala ne omogućava pravljenje
tokena. Sva četiri jezika SDK-a imaju Ed25519 u standardnoj biblioteci.

## 2. Format

```
ppd1.<kid>.<payload>.<sig>
```

| Deo | Sadržaj | Ograničenje |
| --- | --- | --- |
| `ppd1` | verzija + algoritam (Ed25519) | doslovno |
| `kid` | ID ključa (rotacija) | `[a-z0-9-]{1,32}` |
| `payload` | base64url(UTF-8 JSON objekat) | `[A-Za-z0-9_-]+` |
| `sig` | base64url(Ed25519 potpis, 64 bajta) | tačno 86 znakova |

Ceo token: najviše **1024 bajta**. Duži → `malformed` (bez dekodiranja).

**Potpisana poruka** = ASCII bajtovi `ppd1.<kid>.<payload>` (sve pre treće tačke, tačno kako
stoji u tokenu). Potpis pokriva bajtove, ne JSON vrednosti — nema kanonikalizacije JSON-a.

## 3. Payload

```json
{"v":1,"portal":"demo.local","post":"p-1001","vid":"AAECAwQFBgcICQoLDA0ODw","iat":1792000000000}
```

| Polje | Tip | Značenje |
| --- | --- | --- |
| `v` | ceo broj, `1` | verzija payload-a |
| `portal` | string, 1–128 | portal za koji je token izdat |
| `post` | string, 1–256 | post čiji je prikaz izdao token |
| `vid` | string, 22 znaka base64url | ID prikaza (16 bajtova) |
| `iat` | ceo broj | vreme izdavanja, ms |

Nepoznata polja se ignorišu. Polje koje nedostaje ili ima pogrešan tip → `malformed`.

**Namerno nema:** roka važenja, minimalne starosti, ograničenja broja upotreba, IP-a.
Sve to su pragovi ili lični podaci; token je čitljiv napadaču (potpisan, nije šifrovan).
Pragovi su u konfiguraciji SDK-a (`sdk.md` §3), a veza tokena sa mrežom klijenta proverava
se u engine-u iz događaja, ne u SDK-u.

## 4. Provera — redosled je normativan

SDK MORA da proverava ovim redom i vrati **prvi** neuspeh. Redosled je deo spec-a da bi svi
SDK-ovi davali isti rezultat za isti ulaz (test vektori to proveravaju).

| # | Provera | Rezultat ako ne prođe |
| --- | --- | --- |
| 1 | token postoji i nije prazan string | `missing` |
| 2 | dužina ≤ 1024 i ceo token odgovara regex-u `^ppd1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$` | `malformed` |
| 3 | `kid` postoji u konfiguraciji javnih ključeva | `unknown_key` |
| 4 | `sig` se dekodira u tačno 64 bajta i Ed25519 potpis nad potpisanom porukom je ispravan | `bad_signature` |
| 5 | `payload` se dekodira u validan UTF-8 JSON **objekat** sa svim poljima iz §3 ispravnog tipa, `v == 1`, `vid` od 22 znaka base64url | `malformed` |
| 6 | `portal` == portal iz konfiguracije SDK-a | `wrong_portal` |
| 7 | `post` == post na koji akcija stiže | `wrong_post` |
| 8 | `now_ms − iat ≥ min_age_ms` | `too_young` |
| 9 | `now_ms − iat ≤ max_age_ms` | `expired` |
| 10 | `uses ≤ max_uses` (broj akcija sa istim `vid`, uključujući ovu) | `overused` |
| — | sve prošlo | `valid` |

Napomene:
- **Strogo base64url.** Regex u koraku 2 se proverava **pre** dekodiranja. Neki dekoderi su
  popustljivi (PHP `base64_decode` bez `strict`, Java MIME dekoder) i prihvatili bi `=`,
  razmake ili `+/` — to bi omogućilo više zapisa istog tokena.
- **Potpis pre JSON-a.** JSON se parsira tek kad je potpis proveren (korak 4 pre 5). Napadač
  ne može da natera SDK da parsira proizvoljan JSON. (Zato i duplirani ključevi u JSON-u nisu
  problem: pošten izdavač ih ne pravi, a napadač ne može da potpiše.)
- **Iat u budućnosti** (sat izdavača ispred) daje negativnu starost → `too_young`. Izdavač i
  SDK TREBA da imaju NTP; posebne tolerancije nema.
- **`uses`** broji SDK (atomski brojač po `vid`, vidi `sdk.md` §2). Korak 10 je jedini koji
  zavisi od stanja.

## 5. Izdavanje (`ppd-api`)

`POST /v1/view`, poziva ga `ts/` posle učitavanja stranice (ne u HTML-u — CDN keš).

Zahtev: `{"portal":"demo.local","post":"p-1001"}`
Odgovor: `{"token":"ppd1....","vid":"AAECAwQFBgcICQoLDA0ODw"}`

- `vid` generiše server (CSPRNG, 16 bajtova). `iat` = vreme servera.
- Server ne potpisuje tokene za portal/post koji nisu registrovani. *(PoC: lista portala u
  konfiguraciji; post se prihvata bilo koji.)*
- Odgovor je isti format bez obzira na to šta engine misli o klijentu (princip 3).

## 6. Rotacija ključeva

Konfiguracija SDK-a sadrži **skup** javnih ključeva po `kid`. Rotacija: dodati novi ključ u
konfiguraciju svih SDK-ova → izdavač prelazi na novi `kid` → posle `max_age_ms` ukloniti stari.

## 7. Test vektori

[`test-vectors/token.json`](test-vectors/token.json). Test ključ (`kid` = `test-1`) je javno
objavljen, sa seed-om, **samo za testove**; nikad u produkciji. Seed omogućava `ppd-core`-u da
deterministički reprodukuje iste tokene (Ed25519 je deterministički).
