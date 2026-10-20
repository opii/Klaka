# Klaker — emulator napadača (`klaker/`)

**Klaker** je član klake (vidi [README](../README.md#zašto-klaka)). Ovde je to alat koji igra
klaku protiv demo portala: pravi koordinisane glasove i komentare sa poznatim obeležjima, a
paralelno pušta i legitimnu publiku. Pošto zna šta je sam uradio, daje **čist ground truth**
za merenje — ono što pravi saobraćaj nikad ne daje (koncept §6, treći izvor oznaka).

Status: plan; prva verzija pokriva nivoe 0–2 (ispod).

---

## 1. Neutralnost je zahtev, ne napomena

Profil napadača opisuje **ponašanje** — kako, kada, odakle i koliko — a nikad stranu, temu ili
stav. Detekcija mora da uhvati klaku bez obzira na to za koga plješće (koncept §0).

Zato klaker svaku kampanju može da pusti **u ogledalu**: isti profil, iste jačine, jednom u
korist jednog skupa komentara/autora, jednom u korist suprotnog. Sistem mora dati statistički
isti signal za obe (koncept §11, simetričnost po stranama). Razlika je greška u detekciji,
ne osobina napadača.

Tekst šablonskih komentara je u profilu i generički („Odlično rečeno.", „Sramota."); sadržaj
nije signal koji Klaka sme da koristi za presudu.

---

## 2. Nivoi napadača

Svaki nivo je odgovor napadača na meru iz prethodnog — redosled prati tabelu cene (koncept §9).
Merimo koliko glasova svaki nivo progura u javni zbir.

| Nivo | Ko je to | Ponašanje | Šta Klaka treba da vidi |
| --- | --- | --- | --- |
| 0 | skripta | sirov `POST` na API portala, bez stranice i JS-a | `token = missing` → `shadow` |
| 1 | skripta koja zna za token | uzima token direktno sa `/v1/view`, glasa odmah ili istim tokenom više puta | `too_young`, `overused`; `view` bez `engage` |
| 2 | headless browser | učitava stranicu, čeka da token „sazri", glasa rafalno bez čitanja | `engage` bez skrolovanja, `jumps`, glas na komentar koji nije bio u `seen`, `navigator.webdriver` |
| 3 | pažljiv browser | čita, skroluje, glasa samo za vidljive komentare, nasumična kašnjenja | pojedinačno čist — vidi se tek u kohorti (ponavljanje kroz postove, zajednički prefiks, isti ciljevi) |
| 4 | ljudi u smenama | nivo 3 + raspored smena, rotacija pseudonima, šablonski komentari i parafraze (lokalni LLM) | graf kohorte, ritam smena (change-point), šabloni (MinHash, embeddings) |

Nivoi 0–2 hvata ono što postoji danas (token, `shadow`). Nivoi 3–4 su posao engine-a i služe
kao njegov test pre nego što radi na pravom portalu.

---

## 3. Legitimna publika

Lažni pozitivi se mere samo na legitimnoj publici (koncept §6), pa klaker uvek pušta i nju,
u istom vremenu i na iste postove:

- **čitaoci** — dolaze sa različitih referera i prefiksa, čitaju, deo glasa, retko komentarišu;
- **legitimni blizanci napada** (koncept §8) — nalet posle `promotion` događaja (push,
  naslovna), mobilizacija posle deljenja na društvenoj mreži, više čitalaca iza istog
  prefiksa (kancelarija, CGNAT).

Blizanci su najvažniji deo publike: sistem koji ih kažnjava ne sme uživo.

---

## 4. Profil kampanje

Profil je JSON fajl. Generički profili su u repou (`klaker/profiles/`); profili izvedeni iz
stvarnih slučajeva žive lokalno u `klaker/profiles.local/`, koji git ignoriše — kao i svi
podaci o stvarnim mrežama.

```json
{
  "name": "smena-rafal",
  "level": 2,
  "operators": 12,
  "shifts": [{ "start": "+0m", "duration": "20m" }],
  "quota": { "votes": 40, "comments": 3 },
  "targets": { "push": ["c1", "c3"], "sink": ["c2"] },
  "mirror": true,
  "net": { "prefixes": 2 },
  "delay_ms": { "dist": "lognormal", "median": 400, "sigma": 0.6 },
  "comments": { "templates": "generic", "paraphrase": false },
  "audience": { "readers": 200, "twins": ["promotion"] }
}
```

`targets.push` / `sink` su ID-jevi komentara koje kampanja gura ili potiskuje; sa
`"mirror": true` klaker pušta i obrnutu kampanju.

---

## 5. Mrežni prefiks u simulaciji

HTTP klijent ne bira svoju IP adresu. U test okruženju (i samo tamo) demo portal i
`klaka-collector` stoje iza „pouzdanog proxy-ja": čitaju IP iz `X-Forwarded-For`
(`KLAKA_CLIENT_IP_HEADER` u collector-u, isto podešavanje u demo portalu). Klaker tako svakom
operateru i čitaocu dodeljuje adresu.

Adrese su iz opsega rezervisanog za testiranje (`198.18.0.0/15`, RFC 2544; za IPv6
`2001:db8::/32`, RFC 3849), raspoređene u /24 i /48 prefikse po profilu. Raspored zna samo
klaker; za Klaku su to obični prefiksi.

---

## 6. Ground truth i merenje

1. **Klaker beleži** svaku svoju akciju: vreme, uloga (napadač / čitalac / blizanac), nivo,
   kampanja, strana ogledala, prefiks, `vid` (ako ga ima), cilj i smer.
2. **Klaka beleži** isto što i za pravi saobraćaj: `vote` i `comment` događaji sa odlukom
   (`decision`) u tabeli `events` (PostgreSQL, `klaka-collector`).
3. **Spajanje** po `vid` gde postoji, inače po (prefiks, cilj, smer, vreme ± 2 s).
4. **Izveštaj** po nivou i po strani ogledala:

| Merilo | Značenje |
| --- | --- |
| odziv | udeo glasova napadača koji su završili u `shadow` |
| lažni pozitivi | udeo glasova publike u `shadow`; posebno za blizance |
| pomeraj javnog zbira | koliko je kampanja pomerila javni brojač ciljeva — **glavno merilo**: to je jedino što napadač zaista kupuje |
| simetrija | razlika u svemu gore između dve strane ogledala; cilj je nula |

Izveštaj ne čita Valkey ni admin stranice demo portala — samo ono što bi postojalo i na
pravom portalu.

---

## 7. Tehnologija i pokretanje

TypeScript/Node, kao demo i e2e (klaker je alat za testiranje, ne deo našeg sistema). Nivoi
0–1 su `fetch`; nivoi 2–4 koriste Playwright (pravi Chromium). Komentari za nivo 4 se
parafraziraju preko lokalnog Ollama servisa.

```bash
docker compose run --rm klaker run profiles/rafal.json        # jedna kampanja + publika
docker compose run --rm klaker report <run-id>               # izveštaj iz baze
```
