# Događaji — v1

Dva izvora, dva endpointa, ista koverta.

| Izvor | Endpoint (`ppd-collector`) | Autentikacija | Poverenje |
| --- | --- | --- | --- |
| browser (`ts/`) | `POST /v1/events` | nema (javno) | **nikakvo** — sve može biti lažno |
| backend portala (SDK) | `POST /v1/ingest` | `Authorization: Bearer <portal_api_key>` | portal je pouzdan izvor za ono što je sam video (akcija, IP prefiks, odluka moderatora) |

## 1. Koverta

```json
{"v":1,"portal":"demo.local","sent_ms":1792000005000,"events":[ ... ]}
```

| Polje | Tip | Napomena |
| --- | --- | --- |
| `v` | `1` | verzija |
| `portal` | string | kod `/v1/ingest` MORA da se poklapa sa portalom API ključa |
| `sent_ms` | ceo broj | vreme slanja po satu pošiljaoca; collector beleži i svoje vreme prijema |
| `events` | niz, 1–100 | svaki element ima `type` |

Ograničenja (collector odbacuje celu kovertu ako su prekoračena): telo ≤ 64 KB, ≤ 100 događaja.

**Browser → `text/plain`.** `navigator.sendBeacon` sa `Content-Type: text/plain` ne pokreće
CORS preflight. Collector MORA da prihvati JSON telo sa `text/plain` na `/v1/events`.

Odgovor collector-a: uvek `204 No Content` za sintaksno ispravnu kovertu, čak i ako su neki
događaji odbačeni (princip 3: browser ne saznaje ništa). `400` samo za neparsabilnu kovertu.

## 2. Događaji iz browsera (`/v1/events`)

Svi nose `vid` (iz tokena) i `t` (ms, sat browsera).

### `view` — stranica posta je prikazana

| Polje | Tip | Napomena |
| --- | --- | --- |
| `post` | string | |
| `ref` | string \| null | **origin + putanja** referera, bez query-ja i fragmenta (`https://t.co/`) |
| `variant` | string \| null | vrednost canary parametra iz URL-a (koncept §3), ako postoji |
| `lang` | string | `navigator.language` |
| `tz_min` | ceo broj | `-new Date().getTimezoneOffset()` (lokalni ritam vs GeoIP) |
| `vp` | `[w,h]` | veličina viewport-a, **zaokružena na 100 px** |
| `auto` | ceo broj | bitset: 1 = `navigator.webdriver`, ostali bitovi rezervisani |

### `engage` — sažetak čitanja, šalje se na `pagehide` (i periodično na dugim posetama)

| Polje | Tip | Napomena |
| --- | --- | --- |
| `dwell_ms` | ceo broj | ukupno vreme od prikaza |
| `visible_ms` | ceo broj | vreme dok je tab vidljiv |
| `depth_max` | 0–1000 | najdublje dostignuta tačka stranice, promile |
| `depth_hist` | niz 10 celih | ms provedeno u svakoj desetini dubine — **oblik skrolovanja** |
| `jumps` | ceo broj | skokovi > 25% dubine za < 100 ms (`scrollIntoView`, sidro `#komentari`) |
| `first_input_ms` | ceo broj \| null | prva interakcija (taster, pokazivač, dodir) od prikaza |
| `inputs` | `{"key":n,"ptr":n,"touch":n}` | broj interakcija po vrsti |
| `comments_ms` | ceo broj \| null | kada je sekcija komentara prvi put postala vidljiva |
| `seq` | ceo broj | redni broj sažetka za ovaj `vid` (periodično slanje); važi poslednji |

### `honeypot` — interakcija sa mamac-elementom

| Polje | Tip | Napomena |
| --- | --- | --- |
| `hp` | string | ID mamca (nasumičan po prikazu; server zna koji su mamci) |
| `kind` | `"click"` \| `"focus"` \| `"fill"` | |

**Namerno se ne skuplja:** pun URL referera, user-agent (SDK ga vidi na serveru), otisak
platna/fontova/WebGL-a, IP (collector ga vidi i odmah skraćuje). Sve što bi bilo otisak uređaja
traži pravnu proveru (ePrivacy) i dodaje se tek posle nje, kao poseban tip događaja.

## 3. Događaji sa backenda portala (`/v1/ingest`)

Zajednička polja za `vote` i `comment`:

| Polje | Tip | Napomena |
| --- | --- | --- |
| `t` | ceo broj | vreme servera portala |
| `post` | string | |
| `vid` | string \| null | iz tokena, ako je token bio parsabilan (koraci 1–5 prošli) |
| `token` | string | rezultat provere: `valid`, `missing`, `malformed`, … (`token.md` §4) |
| `uses` | ceo broj \| null | stanje brojača upotreba za `vid` posle ove akcije |
| `decision` | `"count"` \| `"shadow"` \| `"challenge"` | šta je SDK uradio (`sdk.md` §2) |
| `net` | string | prefiks: `93.87.12.0/24` ili `2a02:8109:1234::/48` |
| `ua` | string | user-agent, skraćen na 512 bajtova |
| `cid` | string \| null | *opciono:* heš first-party ID-ja posetioca (`sdk.md` §4); traži pravnu proveru |

### `vote`

| Polje | Tip |
| --- | --- |
| `target` | string — ID komentara (ili posta) na koji se glasa |
| `dir` | `1` \| `-1` |

### `comment`

| Polje | Tip | Napomena |
| --- | --- | --- |
| `comment` | string | ID komentara u sistemu portala |
| `author` | string | pseudonim kako ga je korisnik upisao |
| `text` | string | ≤ 8 KB; lični podatak — vidi pravilo za LLM u `tech_stack.md` §3 |
| `reply_to` | string \| null | ID komentara na koji odgovara |

### `moderation` — odluka moderatora (izvor oznaka, koncept §6)

| Polje | Tip | Napomena |
| --- | --- | --- |
| `t` | ceo broj | |
| `comment` | string | |
| `result` | `"approved"` \| `"rejected"` | |
| `reason` | string \| null | razlog iz sistema portala, ako postoji |

Identitet moderatora se ne šalje.

### `post` — objava ili izmena posta

| Polje | Tip | Napomena |
| --- | --- | --- |
| `t` | ceo broj | |
| `post` | string | |
| `rev` | ceo broj | revizija; raste pri svakoj izmeni |
| `url` | string | kanonski URL |
| `title` | string | |
| `section` | string \| null | rubrika (za cross-topic baseline) |
| `body` | string \| null | *opciono:* tekst članka (javan) — za profil posta |

## 4. Obrada na collector-u

1. IP zahteva → prefiks (/24, /48) **pre** bilo kakvog upisa; pun IP se ne upisuje nigde,
   ni u logove.
2. ASN i država se dodaju iz prefiksa (iptoasn) na collector-u, ne u SDK-u.
3. Za `/v1/events`: `vid` koji `ppd-api` nije izdao se ne odbacuje nego **označava** — to je
   signal, ne greška.
4. Upis u PostgreSQL, u tabele particionisane po danu; retencija (dani) = brisanje starih particija.
