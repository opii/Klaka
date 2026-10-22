# Tech stack

**Status:** usvojeno 2026-10-20. Menja se samo uz obrazloženje u ovom dokumentu.
**Vezano:** [`koncept_detekcija_sa_portala.md`](koncept_detekcija_sa_portala.md)

---

## 1. Komponente i jezici

```
 browser                 backend portala              naš sistem (Rust)
┌──────────────┐  dog.  ┌──────────────────┐  dog.  ┌──── core/ ─────────────┐
│ ts/          │───────▶│ sdk/             │───────▶│ klaka-collector          │
│ TypeScript   │        │ PHP·Node·Go·Java │        │   → PostgreSQL         │
│ ≤ 8 KB gzip  │        │  - provera tokena│        │ klaka-engine             │
└──────────────┘        │  - čita presude  │◀───────│   → presude u Valkey   │
                        └──────────────────┘ Valkey │ klaka-llm (lokalni / API)│
                                                    │ klaka-api (tokeni, UI)   │
                                                    └────────────────────────┘
```

| Deo | Jezik | Zašto |
| --- | --- | --- |
| naš sistem | **Rust** | parsira neproveren ulaz (događaji koje napadač može da falsifikuje, tekst komentara); memorijska bezbednost bez `unsafe` |
| klijentska biblioteka | **TypeScript**, nula zavisnosti | senzor bez UI-ja; framework ne donosi ništa, a povećava bundle i kod koji napadač čita |
| SDK-ovi | **PHP, Node (TypeScript), Go, Java** | jezici portala; čisti, bez FFI (vidi §4) |
| UI recenzenta | **askama** + obične HTML forme (server-side, iz `klaka-api`, poseban port); htmx kad zatreba delimično osvežavanje | micro, bez frontend build-a i bez JavaScript-a (CSP ga zabranjuje); askama automatski escape-uje |

Python se ne koristi u našem sistemu.

---

## 2. Naš sistem — Cargo workspace

| Crate | Tip | Uloga | Ključni crate-ovi |
| --- | --- | --- | --- |
| `klaka-core` | lib | šema događaja, format tokena (Ed25519), IP → /24, ASN lookup | `serde`, `ed25519-dalek` |
| `klaka-db` | lib | migracije, tabela `events` (particije po danu), upis — zajedničko za collector i api | `sqlx` |
| `klaka-collector` | bin | prima događaje iz browsera i SDK-ova, upisuje u PostgreSQL | `axum`, `tokio`, `sqlx` |
| `klaka-engine` | bin | 7 detektora kohorti (po prefiksu i preko grafa prefiksa: MinHash/LSH, `pgvector` HNSW kNN, Jaccard + $k$-jezgro), presude i naknadni shadow u Valkey, pozadinski radnik za opis (`describe.rs`) i ulogu kohorte (`role.rs`) | `tokio`, `sqlx`, `redis` |
| `klaka-llm` | lib | `trait LlmProvider` + `trait Embedder`; podrazumevano Ollama (lokalno, besplatno), opciono Claude (Anthropic API / Vertex AI); ruter po klasi privatnosti — vidi [`llm.md`](llm.md) | `reqwest`, `serde_json` |
| `klaka-api` | bin | izdavanje tokena pregleda, upravljanje presudama, UI recenzenta | `axum`, `askama`, `sqlx` |

Grafovski algoritmi u `klaka-engine`-u (2-stepeno susedstvo šablona, Jaccard sličnost, $k$-jezgro
i komponente povezanosti u `coordinated.rs` i `comments.rs`) pisani su direktno u čistom Rust-u:
deterministički su, rade u nekoliko milisekundi nad prozorom i potpuno su objašnjivi kad se nalaz
ospori.

---

## 3. Infrastruktura (gotovi servisi, nije naš kod)

| Namena | Izbor | Zašto |
| --- | --- | --- |
| događaji, stanje, audit, red poslova, embeddings | **PostgreSQL 17 + pgvector** (jedna baza) | vidi „Jedna baza" ispod |
| keš presuda | **Valkey** (Redis-kompatibilan) | SDK-ovi ga čitaju direktno; portali često već imaju Redis |
| lokalni LLM i embeddings | **Ollama** (otvoreni modeli, po imenu), zaseban servis | besplatno; modeli se preuzimaju sami; isti HTTP API za generisanje (sa JSON šemom) i embeddings |
| embeddings model | **bge-m3** preko Ollama (1024 dimenzije) | višejezičan (100+ jezika); `ort` u procesu ostaje opcija ako zatreba brzina |

**Ollama + pgvector su par**, obavezan deo sistema: Ollama pravi embeddings, pgvector ih čuva
i pretražuje (HNSW, kosinusna udaljenost). Tako se hvataju **parafrazirani šabloni** preko
postova — i oni koje napadač pravi LLM-om — što MinHash (copy-paste) ne vidi. Provereno
2026-10-20: parafraza napada na udaljenosti 0,108 od originala, nepovezana rečenica 0,629.

**Jedna baza (PostgreSQL) umesto ClickHouse-a** — odluka 2026-10-20, za PoC i dok obim to
dozvoljava:
- događaji u tabelama **particionisanim po danu**; retencija („dani, ne godine") = brisanje
  starih particija, jeftino koliko i TTL;
- embeddings (pgvector) u istoj bazi kao komentari — upit „slični komentari na drugim
  postovima u poslednjih 7 dana" je jedan SQL, bez prebacivanja između servisa;
- red poslova (`FOR UPDATE SKIP LOCKED`) i audit takođe tu.

ClickHouse se vraća u razmatranje kad merenje pokaže da Postgres ne stiže sa obimom događaja.
Upiti su iza našeg Rust koda, pa zamena pogađa samo collector i engine.

`pgvector` mora biti ≥ 0.8 (iterativno skeniranje indeksa — HNSW sa jakim `WHERE` filterom,
npr. jedan portal i 7 dana). Compose koristi `pgvector/pgvector:0.8.1-pg17`; ekstenzija se
uključuje pri inicijalizaciji (`core/deploy/postgres-init/`), šemu vode migracije u `core/`.
| ASN / država | **iptoasn** dataset, sopstveni lookup | slobodna licenca (GeoLite ima uslove korišćenja) |
| graf kohorte | **bez graf baze** — vidi ispod | |

**Zašto nema graf baze (npr. Neo4j):** graf je ovde **međukorak računanja**, a ne predmet
slobodnog istraživanja:
PostgreSQL vraća događaje i HNSW kNN parove iz klizećeg prozora, `klaka-engine` u memoriji
sklapa grafove usklađenih glasova (`coordinated.rs`) i šablona (`comments.rs`, susedstvo na 2
koraka) i nalazi kohorte preko Jaccard sličnosti, $k$-jezgra i komponenti povezanosti za nekoliko
milisekundi, a trajni rezultati (presude, dokazi, naknadni shadow) idu u PostgreSQL. Graf jednog
prozora lako staje u memoriju. Neo4j bi dodao servis i JVM bez računske koristi. Vraćamo ga u
razmatranje tek ako recenzentima zatreba slobodno istraživanje grafa koje UI ne pokriva.

Razvoj: `docker-compose.yaml` u korenu (sve u kontejnerima, uključujući Rust i Node alate). Self-hosted produkcija: `core/deploy/` (kasnije). Za početak bez reda poruka: collector piše u
PostgreSQL, engine čita prozore. NATS tek kad zatreba.

**Pravilo za LLM** (iz koncepta §5): tekst članka je javan → može ka API-ju; komentari i
pseudonimi su lični podaci → lokalno, osim ako portal izričito dozvoli API uz DPA. Izbor je u
konfiguraciji po portalu. Izlaz LLM-a je savetodavan; nijedna presuda ne zavisi samo od njega.

---

## 4. Token pregleda i SDK-ovi

Token potpisuje `klaka-api` ključem **Ed25519**; portal (SDK) ima **samo javni ključ**.

- Provala portala ne omogućava pravljenje tokena (kod HMAC-a bi deljeni ključ bio kod svakog portala).
- Sva četiri jezika proveravaju Ed25519 **standardnom bibliotekom** → nema native zavisnosti,
  PHP radi i na deljenom hostingu.

| SDK | Minimalna verzija | Ed25519 | Keš presuda |
| --- | --- | --- | --- |
| PHP (Composer) | 8.1 | `sodium` (ugrađen) | Valkey + APCu |
| Node (npm, TypeScript) | 18 | `node:crypto` | Valkey + LRU u memoriji |
| Go (module) | 1.22 | `crypto/ed25519` | Valkey + `sync.Map` |
| Java (Maven) | 17 | `java.security` | Valkey + Caffeine |

**Proof of concept: prvo samo Node SDK** (odluka 2026-10-20). Demo portal, SDK i klijent su
tada svi u TypeScript-u, pa se ceo tok čita u jednom jeziku. Ograničenje: PoC ne sme da se
osloni na ono što PHP nema (trajan proces) — presude se čitaju iz Valkey-ja, keš u memoriji je
samo optimizacija. Ostali SDK-ovi slede tek kad PoC potvrdi protokol.

**Konzistentnost se ne postiže deljenim kodom nego deljenim test vektorima:**
`core/spec/test-vectors/` (važeći, istekao, pogrešan potpis, izmenjen payload, pogrešan post…).
Svaki SDK ih prolazi u CI-ju. `klaka-core` u WASM-u ostaje opcija za edge varijantu
(Cloudflare Worker), kasnije.

---

## 5. Klijentska biblioteka

- TypeScript, nula runtime zavisnosti, bundle **esbuild**; budžet **≤ 8 KB gzip**.
- Isporuka: `klaka.min.js` (IIFE, za `<script>`) + ESM build.
- Testovi: **Vitest** (jedinice) + **Playwright** (pravi browser: skrol, `seen`, `compose`, headless potpis).
- Obim: događaji (prikaz, oblik skrolovanja, dwell, prva interakcija), dohvatanje tokena posle
  učitavanja (zbog CDN keša), nasumičan DOM, slanje preko `sendBeacon`. Honeypot elementi su
  svesno van opsega (koncept §10: autofill i menadžeri lozinki daju lažne pozitive). **Nikakva logika odlučivanja** — napadač čita ovaj kod.

---

## 6. Raspored repoa

**Monorepo, za sada.** Sve komponente, SDK-ovi i specifikacija u jednom repou, da se protokol
i svi njegovi korisnici menjaju u istom commitu. **Kad dođe do objavljivanja, delovi se dele u
zasebne repoe.**

**Pravilo rasporeda:** prvi nivo je **namena**, drugi nivo je **tehnologija** — samo kad namena
ima više tehnologija. Svaki list te podele je samostalan (svoj `README.md`, `.gitignore`, build)
i kasnije postaje zaseban git repo.

```
core/                    naš sistem, Rust            → repo klaka-core
  Cargo.toml, rust-toolchain.toml
  crates/                klaka-core, klaka-db, klaka-collector, klaka-engine, klaka-llm, klaka-api
  spec/                  protokol (token, šema događaja, presude) + test-vectors/
  deploy/                docker compose za self-hosted
sdk/                     SDK-ovi za backend portala
  php/                                               → repo klaka-sdk-php
  node/                                              → repo klaka-sdk-node
  go/                                                → repo klaka-sdk-go
  java/                                              → repo klaka-sdk-java
ts/                      klijentska biblioteka (browser), TypeScript → repo klaka-ts
demo/                    demo portal (Node, TypeScript) — PoC i e2e test celog lanca
caci/                    emulator klake: poslušnici u tri uloge (Node, TypeScript, Playwright) — testiranje detekcije
docs/                    zajednička dokumentacija (ostaje u korenu)
```

`spec/` je u `core/` jer core izdaje i potpisuje tokene, pa je on izvor istine za format i
test vektore. Posle podele, SDK repoi uzimaju `test-vectors/` iz verzionisanog izdanja core-a;
dok smo monorepo, čitaju ih relativnom putanjom `../../core/spec/test-vectors/`.

*Napomena:* folder `core/` i crate `klaka-core` (`core/crates/klaka-core`) dele ime u različitom
smislu — folder je ceo naš sistem, crate je biblioteka zajedničkih tipova. Ako počne da zbunjuje,
crate se preimenuje (npr. `klaka-proto`).

Zašto podela pri objavljivanju, a ne ranije — registri i poddirektorijumi:

| Registar | Može iz poddirektorijuma monorepoa? |
| --- | --- |
| npm (Node SDK, ts) | da — `npm publish` iz `sdk/node/`, `ts/` |
| Maven Central (Java) | da — build iz `sdk/java/` |
| Go module proxy | da — modul putanje `…/sdk/go`, tagovi oblika `sdk/go/v0.1.0` |
| Packagist (PHP) | **ne** — očekuje `composer.json` u korenu repoa → split repo samo za čitanje (`git subtree split` u CI-ju) |

---

## 7. Alati

| | |
| --- | --- |
| Rust | stable, edition 2024; `cargo clippy`, `cargo fmt`, `cargo-deny` (licence i ranjivosti) |
| TypeScript | `strict`, ESLint, Prettier |
| PHP | PHPUnit, PHPStan |
| Go | `go test`, `go vet` |
| Java | JUnit 5, Maven |

---

## 8. Emulator klake — `caci/`

Članovi klake su poslušnici: **pojačivači** (guraju), **razvodnjivači** (gase temu) i
**ćaci** (zli ljudski bot — toksičan poslušnik). Emulator je referentni protivnik za testiranje detekcije u
zatvorenom Docker Compose okruženju, bez živih portala. Igra sve tri uloge na nivoima od sirove
skripte do ljudi u smenama, paralelno pušta legitimnu publiku i daje ground truth za odziv,
lažne pozitive i simetriju po stranama.

- **Tehnologija:** TypeScript/Node + Playwright (alat, ne deo našeg sistema — Rust ograničenje
  se ne odnosi na njega).
- **Profili:** generički u `caci/profiles/`; profili izvedeni iz stvarnih slučajeva samo
  lokalno (`caci/profiles.local/`, van gita).
- Detalji: [`caci.md`](caci.md).
