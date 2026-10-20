# Ćaci — zli ljudski bot (i emulator klake, `caci/`)

## 1. Poslušnici: pojačivači, ćaci i razvodnjivači

**Klaka** je pojava — plaćeno lažiranje publike (vidi [README](../README.md#zašto-klaka)).
Njeni članovi su **poslušnici**: ljudi bez sopstvenog stava u toj ulozi, moralno potkupljivi,
koji za sitnu korist (kvota, dnevnica, obećanje posla) glasaju i komentarišu po naređenju, u
smenama, sa tuđim tezama i pod tuđim pseudonimima. Lenji su i seku krivine kad god mogu:
skripta umesto čitanja, ista fraza umesto misli, ista mreža za celu smenu.

Poslušnici imaju tri uloge, po **efektu** na raspravu:

| Uloga | Efekat | Šta radi | Toksičan |
| --- | --- | --- | --- |
| **pojačivač** | gura | glasa za ciljeve, hvali, ponavlja teze, pravi utisak većine | ne |
| **ćaci** | ruši | vređa, ponižava, guši raspravu, potiskuje glasovima, napada autore | da |
| **razvodnjivač** | gasi | zatrpava vruću temu mirnim, praznim ili skrenutim komentarima, da prava rasprava potone i tema posivi | ne |

**Ćaci** je zli ljudski bot: toksičan poslušnik, čovek koji se na internetu ponaša kao bot.
Zlonameran i destruktivan — sve suprotno od konstruktivnog, društvenog učesnika rasprave: ne
doprinosi razgovoru nego ga kvari. Pojačivač i razvodnjivač imaju iste loše namere i isti
gazda ih plaća, ali nisu ćaci dok nisu toksični.

Razvodnjivač je najpodmukliji: svaki njegov komentar je pojedinačno bezazlen. Plaćeni
komentatori često ne ulaze u svađu nego navijaju i skreću pažnju — to je dokumentovano i na
procurelim podacima jedne državne mreže (King, Pan, Roberts, *American Political Science
Review*, 2017: „strategic distraction, not engaged argument").

Sve tri uloge se definišu **ponašanjem, ne stranom**: ćaci je ćaci za koga god da plješće.
Detekcija mora da ih uhvati bez obzira na to koga guraju, potiskuju ili kome gase temu
(koncept §0, §11).

**Šta to znači za Klaku — dva koraka:**

1. **Kohorta po koordinaciji.** Isto za sve uloge: ponavljanje kroz postove, ritam, mreža,
   isti ciljevi (koncept §2, §2a). Presuda (`shadow`) zavisi samo od ovoga, nikad od uloge ni
   od sadržaja. Pojačivač je čak najvažniji za glasove: njegov rad je upravo lažni zbir.
2. **Uloga po efektu** — tek za nađenu kohortu, za recenzenta i izveštaj portalu:

| Uloga | Signal na nivou kohorte |
| --- | --- |
| pojačivač | glasovi „za" na iste ciljeve, pohvale, ponavljanje teza (šabloni) |
| ćaci | toksičnost komentara, glasovi „protiv", napadi na iste autore (`target_author`) |
| razvodnjivač | mala relevantnost za post (embedding komentara naspram profila posta iz `post.body`), malo sadržaja, nalet baš na postu sa živom raspravom, udeo prvog ekrana koji zauzima kohorta (`seen`) |

Uloga se ocenjuje na **kohorti, ne na pojedincu**: i pravi čitaoci ponekad pišu prazne ili
grube komentare. Ocena toksičnosti i relevantnosti mora biti ista za isti ton bez obzira na
stav (koncept §5); toksičan ili prazan komentar organskog čitaoca je posao moderacije, ne Klake.

Poslušnik je i najteži protivnik. Skriptu hvata token pregleda; čoveka u pravom browseru ne
hvata. Ono što poslušnici ne mogu da sakriju je da **ih je ograničeno mnogo** i da rade **po
naređenju i rasporedu** (koncept §2, invarijante 1–3) — to se vidi tek u kohorti.

---

## 2. Emulator

`caci/` je alat koji igra klaku — sve tri uloge — protiv demo portala: pravi
koordinisane glasove i komentare sa poznatim obeležjima, a paralelno pušta i legitimnu
publiku. Pošto zna šta je sam uradio, daje **čist ground truth** za merenje — ono što pravi
saobraćaj nikad ne daje (koncept §6, treći izvor oznaka).

Status: nivoi 0–1 rade (uloge koje glasaju, ogledalo, čitaoci, izveštaj); nivo 2 i
razvodnjivači slede.

### 2.1. Ogledalo

Profil kampanje opisuje **ponašanje** — kako, kada, odakle i koliko — a nikad stranu, temu ili
stav. Zato emulator svaku kampanju može da pusti **u ogledalu**: isti profil, iste jačine,
jednom u korist jednog skupa komentara/autora, jednom u korist suprotnog. Sistem mora dati
statistički isti signal za obe (koncept §11, simetričnost po stranama). Razlika je greška u
detekciji, ne osobina klake.

Tekst šablonskih komentara je u profilu i generički (pojačivač: „Odlično rečeno.", ćaci:
„Sramota, ko ovo uopšte čita.", razvodnjivač: „Lep dan danas, pozdrav svima."), bez teme i
strane. Sadržaj nije signal koji Klaka sme da koristi za presudu.

---

## 3. Nivoi

Svaki nivo je odgovor poslušnika na meru iz prethodnog — redosled prati tabelu cene (koncept §9).
Merimo koliko glasova svaki nivo progura u javni zbir.

| Nivo | Poslušnik | Ponašanje | Šta Klaka treba da vidi |
| --- | --- | --- | --- |
| 0 | najlenjiji: skripta | sirov `POST` na API portala, bez stranice i JS-a | `token = missing` → `shadow` |
| 1 | skripta koja zna za token | uzima token direktno sa `/v1/view`, glasa odmah ili istim tokenom više puta | `too_young`, `overused`; `view` bez `engage` |
| 2 | headless browser | učitava stranicu, čeka da token „sazri", glasa rafalno bez čitanja | `engage` bez skrolovanja, `jumps`, glas na komentar koji nije bio u `seen`, `navigator.webdriver` |
| 3 | pažljiv browser | čita, skroluje, glasa samo za vidljive komentare, nasumična kašnjenja | pojedinačno čist — vidi se tek u kohorti (ponavljanje kroz postove, zajednički prefiks, isti ciljevi) |
| 4 | smena poslušnika | nivo 3 + raspored smena, rotacija pseudonima, šablonski komentari i parafraze (lokalni LLM) | graf kohorte, ritam smena (change-point), šabloni (MinHash, embeddings) |

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
  "roles": { "amplifier": 6, "caci": 3, "diluter": 3 },
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

`roles` je broj poslušnika po ulozi: pojačivači glasaju za `push` i pišu pohvale, ćaci glasaju
protiv `sink` i pišu toksične šablone, razvodnjivači pišu prazne i skrenute komentare i
glasaju za njih. `targets.push` / `sink` su ID-jevi komentara koje kampanja gura ili
potiskuje; sa `"mirror": true` emulator pušta i obrnutu kampanju.

---

## 6. Mrežni prefiks u simulaciji

HTTP klijent ne bira svoju IP adresu. U test okruženju (i samo tamo) demo portal i
`klaka-collector` stoje iza „pouzdanog proxy-ja": čitaju IP iz `X-Forwarded-For`
(`KLAKA_CLIENT_IP_HEADER` u collector-u, isto podešavanje u demo portalu). Emulator tako
svakom poslušniku i čitaocu dodeljuje adresu.

Adrese su iz opsega rezervisanog za testiranje (`198.18.0.0/15`, RFC 2544; za IPv6
`2001:db8::/32`, RFC 3849), raspoređene u /24 i /48 prefikse po profilu. Raspored zna samo
emulator; za Klaku su to obični prefiksi.

---

## 7. Ground truth i merenje

1. **Emulator beleži** svaku svoju akciju: vreme, uloga (pojačivač / ćaci / razvodnjivač /
   čitalac / blizanac), nivo, kampanja, strana ogledala, prefiks, `vid` (ako ga ima), cilj i smer.
2. **Klaka beleži** isto što i za pravi saobraćaj: `vote` i `comment` događaji sa odlukom
   (`decision`) u tabeli `events` (PostgreSQL, `klaka-collector`).
3. **Spajanje** po `vid` gde postoji, inače po (prefiks, cilj, smer, vreme ± 2 s).
4. **Izveštaj** po nivou i po strani ogledala:

| Merilo | Značenje |
| --- | --- |
| odziv | udeo glasova poslušnika (po ulozi) koji su završili u `shadow` |
| lažni pozitivi | udeo glasova publike u `shadow`; posebno za blizance |
| pomeraj javnog zbira | koliko je kampanja pomerila javni brojač ciljeva — **glavno merilo**: to je jedino što se klaki plaća |
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
