# Ćaci — zli ljudski bot (i njegov emulator, `caci/`)

## 1. Ko je ćaci

**Ćaci** je zli ljudski bot: čovek koji se na internetu ponaša kao bot. Zlonameran i
destruktivan — sve suprotno od konstruktivnog, društvenog učesnika rasprave: ne doprinosi
razgovoru nego ga kvari. Poslušnik bez sopstvenog stava i moralno potkupljiv — za sitnu
korist (kvota, dnevnica, obećanje posla) glasa i komentariše po naređenju, u smenama, sa
tuđim tezama i pod tuđim pseudonimima. Lenj je i seče krivine kad god može: skripta umesto
čitanja, ista fraza umesto misli, ista mreža za celu smenu.

**Klaka** je pojava — plaćeno lažiranje publike (vidi [README](../README.md#zašto-klaka));
**ćaci** su njeni pojedinačni akteri. Kad ih ima dovoljno i rade složno, čine kohortu
(koncept §2a).

Ćaci se definiše **ponašanjem, ne stranom**: ćaci je ćaci za koga god da plješće. Detekcija
mora da ga uhvati bez obzira na to koga gura ili potiskuje (koncept §0, §11).

Ćaci je i najteži protivnik. Skriptu hvata token pregleda; čoveka u pravom browseru ne hvata.
Ono što ćaci ne može da sakrije je da **ih je ograničeno mnogo** i da rade **po naređenju i
rasporedu** (koncept §2, invarijante 1–3) — to se vidi tek u kohorti.

---

## 2. Emulator

`caci/` je alat koji igra ćacije protiv demo portala: pravi koordinisane glasove i
komentare sa poznatim obeležjima, a paralelno pušta i legitimnu publiku. Pošto zna šta je sam
uradio, daje **čist ground truth** za merenje — ono što pravi saobraćaj nikad ne daje
(koncept §6, treći izvor oznaka).

Status: plan; prva verzija pokriva nivoe 0–2 (ispod).

### 2.1. Ogledalo

Profil ćacija opisuje **ponašanje** — kako, kada, odakle i koliko — a nikad stranu, temu ili
stav. Zato emulator svaku kampanju može da pusti **u ogledalu**: isti profil, iste jačine,
jednom u korist jednog skupa komentara/autora, jednom u korist suprotnog. Sistem mora dati
statistički isti signal za obe (koncept §11, simetričnost po stranama). Razlika je greška u
detekciji, ne osobina ćacija.

Tekst šablonskih komentara je u profilu i generički („Odlično rečeno.", „Sramota."); sadržaj
nije signal koji Klaka sme da koristi za presudu.

---

## 3. Nivoi

Svaki nivo je odgovor ćacija na meru iz prethodnog — redosled prati tabelu cene (koncept §9).
Merimo koliko glasova svaki nivo progura u javni zbir.

| Nivo | Ćaci | Ponašanje | Šta Klaka treba da vidi |
| --- | --- | --- | --- |
| 0 | najlenjiji: skripta | sirov `POST` na API portala, bez stranice i JS-a | `token = missing` → `shadow` |
| 1 | skripta koja zna za token | uzima token direktno sa `/v1/view`, glasa odmah ili istim tokenom više puta | `too_young`, `overused`; `view` bez `engage` |
| 2 | headless browser | učitava stranicu, čeka da token „sazri", glasa rafalno bez čitanja | `engage` bez skrolovanja, `jumps`, glas na komentar koji nije bio u `seen`, `navigator.webdriver` |
| 3 | pažljiv browser | čita, skroluje, glasa samo za vidljive komentare, nasumična kašnjenja | pojedinačno čist — vidi se tek u kohorti (ponavljanje kroz postove, zajednički prefiks, isti ciljevi) |
| 4 | smena ćacija | nivo 3 + raspored smena, rotacija pseudonima, šablonski komentari i parafraze (lokalni LLM) | graf kohorte, ritam smena (change-point), šabloni (MinHash, embeddings) |

Nivoe 0–2 hvata ono što postoji danas (token, `shadow`). Nivoi 3–4 su posao engine-a i služe
kao njegov test pre nego što radi na pravom portalu.

---

## 4. Legitimna publika

Lažni pozitivi se mere samo na legitimnoj publici (koncept §6), pa emulator uvek pušta i nju,
u istom vremenu i na iste postove:

- **čitaoci** — dolaze sa različitih referera i prefiksa, čitaju, deo glasa, retko komentarišu;
- **legitimni blizanci** (koncept §8) — nalet posle `promotion` događaja (push, naslovna),
  mobilizacija posle deljenja na društvenoj mreži, više čitalaca iza istog prefiksa
  (kancelarija, CGNAT).

Blizanci su najvažniji deo publike: sistem koji ih kažnjava ne sme uživo.

---

## 5. Profil kampanje

Profil je JSON fajl. Generički profili su u repou (`caci/profiles/`); profili izvedeni iz
stvarnih slučajeva žive lokalno u `caci/profiles.local/`, koji git ignoriše — kao i svi
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
`"mirror": true` emulator pušta i obrnutu kampanju.

---

## 6. Mrežni prefiks u simulaciji

HTTP klijent ne bira svoju IP adresu. U test okruženju (i samo tamo) demo portal i
`klaka-collector` stoje iza „pouzdanog proxy-ja": čitaju IP iz `X-Forwarded-For`
(`KLAKA_CLIENT_IP_HEADER` u collector-u, isto podešavanje u demo portalu). Emulator tako
svakom ćaciju i čitaocu dodeljuje adresu.

Adrese su iz opsega rezervisanog za testiranje (`198.18.0.0/15`, RFC 2544; za IPv6
`2001:db8::/32`, RFC 3849), raspoređene u /24 i /48 prefikse po profilu. Raspored zna samo
emulator; za Klaku su to obični prefiksi.

---

## 7. Ground truth i merenje

1. **Emulator beleži** svaku svoju akciju: vreme, uloga (ćaci / čitalac / blizanac), nivo,
   kampanja, strana ogledala, prefiks, `vid` (ako ga ima), cilj i smer.
2. **Klaka beleži** isto što i za pravi saobraćaj: `vote` i `comment` događaji sa odlukom
   (`decision`) u tabeli `events` (PostgreSQL, `klaka-collector`).
3. **Spajanje** po `vid` gde postoji, inače po (prefiks, cilj, smer, vreme ± 2 s).
4. **Izveštaj** po nivou i po strani ogledala:

| Merilo | Značenje |
| --- | --- |
| odziv | udeo glasova ćacija koji su završili u `shadow` |
| lažni pozitivi | udeo glasova publike u `shadow`; posebno za blizance |
| pomeraj javnog zbira | koliko je kampanja pomerila javni brojač ciljeva — **glavno merilo**: to je jedino što se ćaciju plaća |
| simetrija | razlika u svemu gore između dve strane ogledala; cilj je nula |

Izveštaj ne čita Valkey ni admin stranice demo portala — samo ono što bi postojalo i na
pravom portalu.

---

## 8. Tehnologija i pokretanje

TypeScript/Node, kao demo i e2e (emulator je alat za testiranje, ne deo našeg sistema).
Nivoi 0–1 su `fetch`; nivoi 2–4 koriste Playwright (pravi Chromium). Komentari za nivo 4 se
parafraziraju preko lokalnog Ollama servisa.

```bash
docker compose run --rm caci run profiles/rafal.json        # jedna kampanja + publika
docker compose run --rm caci report <run-id>               # izveštaj iz baze
```
