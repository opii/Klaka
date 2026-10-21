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
grube komentare.

**Kako je Klaka računa** (`klaka-engine` `role.rs`, pravila `u4`): za prefiks presude, iz prozora
dokaza i 2 minuta posle presude (kohorta tada još radi) — iz glasova odmah, i bez generativnog
modela; kad stigne opis kohorte, preračuna se sa njim. Uloge dele prefiks
(ista kancelarija), pa je ishod **skup uloga, svaka sa razlogom**:

- **pojačivač** — glasovi „za" na tuđe komentare (≥ 3 i ≥ četvrtina glasova prefiksa), ili po
  opisu modela bar četvrtina komentara hvali, ili je stav „podrška";
- **ćaci** — glasovi „protiv" (uz autore na koje ciljaju), ili komentari koji napadaju **uz**
  toksičnost, ili izrazita toksičnost;
- **razvodnjivač** — većina komentara skreće sa teme, ili su komentari na jednom članku (≥ 80%)
  uz skretanje, ili glasovi „za" komentare sopstvene kohorte (≥ 3, ≥ četvrtina glasova i više
  nego za tuđe; od `u4` i kad zatrpava više članaka) — razvodnjivači glasaju jedni za druge, da
  njihov sadržaj ostane gore.

Relevantnost prema tekstu članka (embeddings) odvaja klaku od publike (0,26–0,34 prema
0,44–0,51), ali ne uloge međusobno — opšte pohvale, uvrede i skretanje se podjednako slabo tiču
članka — pa je razlog uz ulogu, ne pravilo. Mali model loše broji male kohorte („1 hvali, 1
napada" uz „komentari se slažu i hvale"), pa nijedan broj sam ne pravi ćacija ni razvodnjivača.

Izmereno na 9 izvođenja (72 prefiksa sa presudom, uloge iz dnevnika): tačan skup uloga 63/72;
pojačivač 61 pogođen, 3 propuštena, 1 lažan; ćaci 28/28, 1 lažan; razvodnjivač 8 pogođenih, 4
propuštena (manjina u `smena-4`: 2 od 8 komentara prefiksa). Pravila su podešavana na istim
izvođenjima — mera je optimistična dok se ne proveri na novim profilima i pravim podacima.

**Provera na novim profilima** (`uloge-3`, `uloge-4`: novi tekstovi šablona, svaka uloga na svojim
prefiksima, razvodnjivači na dva članka; pravila `u3` nepromenjena): tačan skup uloga **16/24**.
Ćaci 8/8 bez lažnih (glasovi „protiv" i toksičnost); pojačivač 8/8, ali uz 5 lažnih; razvodnjivač
2/8. Uzrok je brojanje malog modela: za čisto skretanje („Danas sam pravio sarmu") kaže da skreće
2–3 od 8, a da 1–2 „hvale" — to prelazi prag pojačivača —, a pravilo „jedan članak" ne važi kad
razvodnjivači zatrpavaju dva. Relevantnost ni ovde ne razdvaja (0,33–0,37, publika 0,36–0,37).

**Sa većim modelom** (`gemma3:12b`, izabran merenjem, `docs/llm.md` §7), isti opisi ponovo, pravila
`u3` nepromenjena: **24/24** — uzrok je bio model, ne pravila. Pravila `u4` (glasovi „za"
sopstvenu kohortu i na više članaka) ne menjaju ni jedan ni drugi skup (63/72, 24/24); na svežem
profilu `uloge-5` (treći skup šablona, drugi ciljevi i članci): **6/6**. Mali uzorci, sintetički
emulator — prava mera dolazi sa označenim kohortama sa portala. Ocena toksičnosti i relevantnosti mora biti ista za isti ton bez obzira na
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

Status: nivoi 0–4 i sve tri uloge rade (glasovi i komentari, ogledalo, smene, rotacija
pseudonima, parafraze, čitaoci koji glasaju i komentarišu, CGNAT blizanac, izveštaj sa
presudama engine-a). Nivo 3 engine hvata kad kampanja ide kroz više postova (usmereni glasovi),
a kampanju na jednom postu ne hvata. Komentare hvataju nenapisani komentari (nalepljeni, bez
forme) i deljeni šabloni (kopije i parafraze kroz više postova). Ono što je kohorta uradila dok
se nije skupila skida naknadni shadow (`verdicts.md` §5): portal ga primenjuje posle presude.

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

Nivoe 0–1 hvata token, nivo 2 bihevioralni detektori engine-a (prikazi-duhovi, nečitani glasovi,
nenapisani komentari). Nivo 3 hvata detektor usmerenih glasova: isti prefiks, isti autor
komentara i smer, kroz više postova, mnogo češće nego organska publika; kucane komentare hvata
detektor deljenih šablona (ista formulacija kroz postove). Kampanja na jednom postu ostaje ispod
praga — pravilo preseka traži više postova (koncept §2a). Nivo 4 (smene, pseudonimi, parafraze)
hvataju isti detektori, sporije: smena ima manje poslušnika, a parafraze su manje slične od kopija.
Klaku rasutu po mnogo prefiksa (svaki poslušnik svoj, par glasova — ispod svih pragova po
prefiksu) hvata graf usklađenih glasova: isti ciljevi, isti smer, u razmaku ≤ 120 s, kroz više
postova. Ako piše komentare, hvata je graf usklađenih šablona: prefiksi koji dele bar dva ista
šablona (kopija ili parafraza, direktno ili preko zajedničkog blizanca — ne u dužem lancu, koji
bi parafraze malog modela spojio u jedan šablon), kroz više postova. Članovi oba grafa ne ulaze u organski
udeo detektora po prefiksu — rasuta klaka bi ga inače svojim šablonima i glasovima podigla i
zaštitila i koncentrisanu.

---

## 4. Legitimna publika

Lažni pozitivi se mere samo na legitimnoj publici (koncept §6), pa emulator uvek pušta i nju,
u istom vremenu i na iste postove:

- **čitaoci** — dolaze sa različitih referera i prefiksa, čitaju, deo glasa, retko komentarišu;
- **legitimni blizanci** (koncept §8) — nalet posle `promotion` događaja (push, naslovna),
  mobilizacija posle deljenja na društvenoj mreži, više čitalaca iza istog prefiksa
  (kancelarija, CGNAT). Emulator pušta CGNAT (`audience.cgnat`) i push (`audience.push`: portal
  javi promociju, isti verni čitaoci stižu za par sekundi i glasaju za najbolji komentar, na više
  postova — vremenski i ciljno usklađeni kao klaka, samo legitimno).

Blizanci su najvažniji deo publike: sistem koji ih kažnjava ne sme uživo.

---

## 5. Profil kampanje

Profil je JSON fajl. Generički profili su u repou (`caci/profiles/`); profili izvedeni iz
stvarnih slučajeva žive lokalno u `caci/profiles.local/`, koji git ignoriše — kao i svi
podaci o stvarnim mrežama.

```json
{
  "name": "smena-4",
  "level": 4,
  "roles": { "amplifier": 4, "caci": 2, "diluter": 2 },
  "votes": 6,
  "comments": 2,
  "targets": { "push": ["c1", "c6", "c11"], "sink": ["c2", "c7", "c9"], "dilute": ["p-1003"] },
  "mirror": true,
  "window_s": 8,
  "prefixes": 2,
  "shifts": { "count": 2, "duration_s": 60 },
  "pseudonyms": 3,
  "paraphrase": true,
  "delay_ms": { "median": 800, "sigma": 0.4 },
  "token_wait_ms": 2500,
  "token_per_vote": true,
  "dwell_ms": { "median": 1500, "sigma": 0.3 },
  "audience": { "readers": 50, "cgnat": 20, "read_ms": { "median": 6000, "sigma": 0.6 }, "vote_p": 0.6, "comment_p": 0.15 }
}
```

`roles` je broj poslušnika po ulozi; svaki ima `votes` glasova i `comments` komentara,
izmešanih. Pojačivači glasaju za `push` i pišu pohvale, ćaci glasaju protiv `sink` i pišu
toksične šablone — komentari idu na članke tih ciljeva. Razvodnjivači pišu prazne i skrenute
komentare na članke iz `dilute` i glasaju za komentare drugih razvodnjivača svoje strane (ako
su vidljivi: tuđ shadow komentar se ne vidi). `targets.push` / `sink` su ID-jevi komentara sa
bilo kog članka; sa `"mirror": true` emulator pušta i obrnutu kampanju (razvodnjivači nemaju
stranu, pa obe strane zatrpavaju iste članke).

Nivo 4 dodaje `shifts` (poslušnici raspoređeni u smene koje se smenjuju; svaki radi samo u
svojoj), `pseudonyms` (rotacija pseudonima po komentaru) i `paraphrase` (svaki komentar je
parafraza šablona iz lokalnog LLM-a, napravljena pre početka — kao spisak koji poslušnici
dobiju za smenu). Publika: `readers` čitalaca (svaki čita 1–3 članka), `cgnat` čitalaca iza
jednog prefiksa, verovatnoće glasa (`vote_p`) i komentara (`comment_p`). Komentare publike piše
lokalni LLM pre početka: o naslovu članka, u grupama sa različitim „ličnostima", svaki se koristi
jednom. Organski tekst tako ne liči na šablon — prva verzija ih je sastavljala iz delova, pa su
deljene rečenice izgledale kao kopije (udaljenost 0,04) i publika je ličila na klaku.

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
| pomeraj javnog zbira | koliko je kampanja pomerila javni brojač ciljeva, posle naknadnog shadow-a — **glavno merilo**: to je jedino što se klaki plaća |
| udeo u javnim komentarima | koliko javnih komentara članka je od klake, posle naknadnog shadow-a — merilo za razvodnjivače |
| simetrija | razlika u svemu gore između dve strane ogledala; cilj je nula |

Izveštaj ne čita Valkey ni admin stranice demo portala — samo ono što bi postojalo i na
pravom portalu.

---

## 8. Tehnologija i pokretanje

TypeScript/Node, kao demo i e2e (emulator je alat za testiranje, ne deo našeg sistema).
Nivoi 0–1 su `fetch`; nivoi 2–4 koriste Playwright (pravi Chromium). Komentari za nivo 4 se
parafraziraju preko lokalnog Ollama servisa.

```bash
docker compose run --rm caci run profiles/rafal-0.json      # jedna kampanja + publika
docker compose run --rm caci report <run-id>               # izveštaj iz baze
```
