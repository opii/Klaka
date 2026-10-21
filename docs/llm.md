# LLM sloj — plan

**Status:** E1 (embeddings komentara) radi u `klaka-engine` (§5a); generativni zadaci G1–G3 su
plan. **Vezano:** [`koncept_detekcija_sa_portala.md`](koncept_detekcija_sa_portala.md) §5,
[`tech_stack.md`](tech_stack.md) §2–§3.

Podrazumevano rešenje je **Ollama sa otvorenim modelima** — lokalno i bez troškova. Plaćeni
modeli (Claude preko Anthropic API-ja ili Vertex AI) su opcija koja se uključuje po portalu,
i to samo ako merenje (§7) pokaže da donose razliku vrednu cene.

---

## 0. Mesto LLM-a u sistemu

- **Ollama + pgvector su obavezan par** (embeddings → čuvanje i pretraga sličnosti, §5a). Generativni
  zadaci (G1–G3) su dodatak: token, honeypot i graf kohorte rade i bez njih.
- LLM je **savetodavan**: daje ulaze engine-u (teme, embeddings, sažetke), nikad presudu.
  Konkretno, generativni model **opisuje** semantičku koheziju kohorte (šta grupa poručuje,
  koliko su poruke slične) za recenzenta, i **nema dozvolu** da menja skor, kohortu ni
  presudu. Presudu daju ponašanje i infrastruktura (presek dimenzija,
  [koncept](koncept_detekcija_sa_portala.md) §2a) i čovek. Dva razloga: neutralnost (pristrasnost
  modela ne sme postati pristrasnost sistema) i objašnjivost (kad se nalaz ospori, „model je
  tako rekao" nije dokaz).
- Generativni model vidi samo kohorte koje su **već prešle prag** iz jeftinih metapodataka.
- LLM se **nikad ne poziva na putanji zahteva**. Sve ide kroz pozadinski red poslova.

---

## 1. Zadaci

| # | Zadatak | Ulaz | Izlaz | Učestalost | Privatnost | Vrsta modela |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | **embeddings komentara** — grupisanje parafraziranih šablona | tekst komentara | vektor | svaki komentar | lični | embeddings (`bge-m3`) |
| G1 | **profil posta** — tema, ton, verovatnoća da je meta i smer (pojačavanje / napad) | tekst članka | JSON po šemi | objava + izmena | **javno** | generativni |
| G2 | **opis kohorte** — šta grupa komentara poručuje („izvedena direktiva"), koliko su poruke kohezivne | ≤ 20 reprezentativnih komentara kohorte koja je prešla prag | JSON: sažetak, stav prema članku, kohezija | po kohorti | lični | generativni |
| G3 | **sažetak za recenzenta** | dokazi kohorte (brojke) + uzorak komentara | kratak tekst | po prijavljenoj kohorti | lični | generativni |

**Svesno nema:** generativnog modela po svakom komentaru. Stav se ne klasifikuje komentar po
komentar, nego po **klasteru** (G2 nad reprezentativnim primerima). Tako generativni model
radi desetine do stotine puta dnevno po portalu, a ne desetine hiljada — što na CPU-u bez GPU-a
pravi razliku između „radi" i „ne radi".

---

## 2. Backend-i

| Backend | Podrazumevano | Za koje zadatke | Napomena |
| --- | --- | --- | --- |
| **Ollama** (`/api/chat` sa `format` = JSON šema, `/api/embed`) | **da** | svi | besplatno, otvoreni modeli; obavezan servis u compose-u |
| Claude — Anthropic Messages API | ne | samo `javno` (G1), osim ako portal izričito dozvoli više | plaćeno; uključuje se po portalu |
| Claude na Vertex AI (GCP) | ne | isto kao iznad | plaćeno; za portale koji su već na GCP-u |

Svi backend-i su iza istog interfejsa, pa izbor ne menja ostatak sistema.

---

## 3. Interfejs (`klaka-llm`)

Skica, ne konačni potpisi:

```rust
pub enum Privacy { Public, Personal }

pub struct JsonTask<'a> {
    pub task: &'static str,          // "G1", "G2", …
    pub prompt_version: &'static str,
    pub system: &'a str,
    pub input: &'a str,              // neproveren sadržaj; uvija se u <input>…</input>
    pub schema: &'a serde_json::Value,
    pub privacy: Privacy,
}

#[async_trait]
pub trait LlmProvider {
    async fn generate_json(&self, t: &JsonTask<'_>) -> Result<LlmOutput>;
}

#[async_trait]
pub trait Embedder {
    async fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
}

pub struct LlmOutput {
    pub json: serde_json::Value,
    pub model: String,         // ime modela
    pub model_digest: String,  // Ollama vraća digest; za API: tačan ID modela
    pub latency_ms: u64,
}
```

**Ruter po privatnosti:** `Privacy::Personal` ide samo na backend-e koje konfiguracija
portala označi kao dozvoljene za lične podatke (podrazumevano: samo lokalni). Pravilo važi u
kodu, ne u dokumentaciji — pogrešna konfiguracija ne sme tiho da pošalje komentare napolje.

---

## 4. Ponovljivost i audit

- `temperature = 0`, fiksan `seed` (Ollama ga podržava).
- Uz svaki izlaz se čuva: zadatak, `prompt_version`, heš ulaza, `model` + `model_digest`,
  izlaz, vreme. Kad se nalaz ospori, vidi se tačno šta je model video i rekao *tada*.
- Ograda: ni sa `temperature = 0` izlaz nije bit-identičan na različitom hardveru. Zato se
  čuva izlaz, ne samo ulaz.

---

## 5. Validacija i zaštita

- **Izlaz se validira u Rust-u** prema šemi, čak i kad je generisanje ograničeno šemom.
  Zatvorene enumeracije (tema, ton) se proveravaju. Neuspeh → jedan ponovni pokušaj → podrazumevani
  profil portala sa niskom pouzdanošću.
- **Prompt injection:** ulaz je uvek u razgraničenom bloku, uz sistemsku instrukciju da je to
  podatak, a ne naredba. Šema ograničava štetu: ubačeni tekst može da promeni samo vrednosti
  polja, ne i ponašanje sistema. Sporne vrednosti (npr. skup „objašnjivih" zemalja) se unakrsno
  proveravaju sa statičkom tabelom.
- **Slobodan tekst iz modela** (sažetak, obrazloženje) je izveden iz neproverenog ulaza i
  prikazuje se samo uz escape-ovanje (askama).

---

## 5a. E1 — embeddings u pgvector-u

```sql
CREATE TABLE comment_embedding (
  portal  text          NOT NULL,
  comment text          NOT NULL,
  post    text          NOT NULL,
  t       timestamptz   NOT NULL,
  model   text          NOT NULL,   -- npr. bge-m3@<digest>; vektori različitih modela se ne porede
  emb     halfvec(1024) NOT NULL,
  PRIMARY KEY (portal, comment, model)
);
CREATE INDEX ON comment_embedding USING hnsw (emb halfvec_cosine_ops);

-- kandidati za „isti šablon, druge reči": najbliži komentari na DRUGIM postovima, 7 dana
SELECT comment, post, emb <=> $1 AS dist
FROM comment_embedding
WHERE portal = $2 AND post <> $3 AND model = $4 AND t > now() - interval '7 days'
ORDER BY emb <=> $1
LIMIT 20;
```

- Tok (migracija `0005`, `klaka-engine` `comments.rs`): svaki krug engine uzme komentare iz
  prozora koji još nemaju vektor za trenutni model (red poslova je sama tabela događaja), pošalje
  ih Ollama-i u jednom `/api/embed` pozivu i upiše; detektor deljenih šablona onda za svaki
  komentar iz prozora traži 5 najbližih suseda **sa drugih postova** iz poslednjih 7 dana
  (`KLAKA_ENGINE_TEMPLATE_DAYS`) preko HNSW indeksa, kao u upitu iznad, uz `hnsw.iterative_scan = relaxed_order` (pgvector
  ≥ 0.8: pretraga se nastavlja kad filter odbaci kandidate iz indeksa). Proba na 20.000 vektora:
  plan koristi HNSW, ceo kNN za komentare iz prozora 34 ms. Sused samo iz prozora bi bio lošiji
  izbor — planer bi s pravom uzeo indeks po vremenu i sortiranje, kvadratno u prozoru.
- **Blizanac sa istog posta se ne broji**, ni za kopije ni za parafraze (koncept §8): čitaoci
  istog članka pišu o istoj temi, a citat iz teksta je kopija. Bez tog pravila (do 2026-10-20 u
  kodu) lookback od 7 dana je organski udeo podigao sa 0,19 na 0,28 — čitaoci emulatora pišu o
  ista 4 članka iz izvođenja u izvođenje — i `sabloni-4` je propustio prefiks sa 10/12 šablonskih
  komentara (lift 2,98 uz prag 3). Sa pravilom: organski udeo 0,01–0,10, sva 4 prefiksa za
  26–31 s (`caci/README.md`).
- **Graf usklađenih šablona** (rasuta klaka, `coordinated-templates`) traži i drugi kNN: među
  komentarima prefiksa sa bar dva komentara u prozoru, jer stari blizanci često potroše svih 5
  mesta pa se dva poslušnika iz prozora ne vide direktno. To je poređenje svakog para, ali samo u
  tom skupu — pojedinci sa jednim komentarom (skoro cela publika) u njemu nisu. Dva komentara su
  isti šablon ako su blizanci ili imaju zajedničkog blizanca, ne preko dužeg lanca: `gemma3:4b`
  parafrazu ponekad pomeri ka drugom šablonu iste uloge (udaljenost 0,242 od prvog), a komponenta
  povezanosti bi ta dva šablona spojila u jedan (izmereno, `rasuti-sabloni-4`: 10 klastera umesto
  5, jedan prefiks propušten; sa drugim kNN-om i komponentama dva).
- **Prag za ivice grafa je blaži** (`KLAKA_ENGINE_MAX_GRAPH_DISTANCE = 0,25`; deljeni šabloni po
  prefiksu ostaju na 0,2): ivica traži bar dva para između ista dva prefiksa, Jaccard i kohortu od
  ≥ 5 prefiksa, pa slučajan dodir publike ne pravi kohortu. Sa 0,2 je `rasuti-sabloni-4` hvatao 11–16
  od 16 prefiksa — deo parafraza `gemma3:4b` ispadne tik iznad (0,215–0,283), a poslušnik ima samo
  3 komentara; sa 0,25 16/16 u tri izvođenja. Nijedan čitalac ni CGNAT emulatora ni na 0,28 nema
  ivicu. Šabloni iste uloge (od 0,242) se pod pragom dodiruju, ali to samo dodaje parove — ivicu
  ne briše, jer se broje komentari, ne klasteri. Otvoreno: popularne fraze na velikom portalu
  (publika emulatora piše o članku, ne opšte fraze).
- **MinHash ide prvi** (Rust, bez modela): copy-paste i sitne izmene hvata jeftino, i radi i
  kad Ollama nije dostupna. Kandidati se biraju preko LSH (16 traka po 4 reda: par sličnosti
  0,7 postaje kandidat sa 99%, nepovezan tekst sa 0,2%), ne poređenjem svakog para — 6000
  komentara za deo sekunde. Embeddings dodaju parafraze.
- `halfvec` = upola manje prostora od `vector`, uz zanemarljiv gubitak tačnosti za kosinus.
- Prag udaljenosti se određuje u eval-u (§7), ne unapred. Orijentir sa prvog testa (2026-10-20):
  parafraza napada 0,108, nepovezana rečenica 0,629. Merenje na šablonima emulatora i
  parafrazama iz `gemma3:4b` (3 po šablonu): isti šablon medijana 0,178 (p90 0,41 — mali model
  često promeni smisao), drugi šablon iste uloge od 0,242, ručno pisani organski komentari od
  0,328. Polazni prag `KLAKA_ENGINE_MAX_TEXT_DISTANCE = 0,2`: 69% parafraza ima blizanca, nijedan
  organski komentar (0/16, i do 0,3).
- **Embeddings su izvedeni iz ličnih podataka** (tekst se iz njih delimično može rekonstruisati)
  → ista retencija kao komentari, brišu se zajedno.
- Promena embeddings modela = novi vektori za sve komentare u retenciji (zato kolona `model`).

---

## 5b. G2/G3 — opis kohorte za recenzenta

- **Jedan poziv za oba zadatka** (`klaka-engine` `describe.rs`, `prompt_version = g2-3`): uz
  svaku novu presudu (ne uz dopunu ni obnovu bez nove revizije) posao ulazi u `cohort_summary`, u
  istoj transakciji. Ulaz su brojke iz dokaza, naslovi članaka i do 20 komentara prefiksa iz
  prozora dokaza i još 2 minuta posle presude — kohorta tada još radi (već u shadow-u), a to je
  isto ponašanje (`rasuta-3`: oko polovine glasova posle presude); radnik zato posao uzima tek
  posle tog roka. Prefiks bez komentara (samo glasovi) se preskače.
- **Izlaz po šemi:** `poruka` (šta grupa poručuje, „izvedena direktiva", jedna rečenica), `stav`
  (podrška, napad, skretanje, mešovito), `kohezija` (visoka, srednja, niska), `toksicnost` (nema,
  blaga, izrazita), koliko komentara `hvale`, `napadaju` i `skrecu` (uloge dele prefiks, pa jedan
  stav ne vidi manjinu) i `sazetak` (najviše tri rečenice, uz brojke). Validacija u Rust-u:
  zatvorene enumeracije, dužine, brojevi do broja komentara u ulazu, ostala polja se odbacuju;
  neispravan izlaz ili greška modela — jedan ponovni pokušaj, pa `failed`.
- **Uputstvo modelu:** opisuje samo sadržaj — ne procenjuje da li je grupa koordinisana, ne
  predlaže odluku, isti ton ocenjuje isto bez obzira na stranu; tekst u `<input>` je podatak, a
  oznaka bloka u njemu gubi `<` (komentar ne može da „zatvori" blok i nastavi kao uputstvo).
- **Radnik** je poseban zadatak u engine-u, odvojen od kruga detekcije: detekcija nikad ne čeka
  model. Uzimanje posla je `FOR UPDATE SKIP LOCKED`; posao koji radnik uzme, a ne završi u 10
  minuta (pad), sme se uzeti ponovo.
- **Deo bez modela je u krugu detekcije** (`settle`, jeftin SQL): kohorta bez komentara se zatvara
  i odmah dobija ulogu, kohorta sa komentarima privremenu ulogu iz glasova (radnik je preračuna sa
  opisom), a bez podešenog modela posao se zatvara uz razlog. Inače bi presude samo sa glasovima
  čekale u redu iza opisa od po minut, a bez modela ulogu ne bi dobile nikad.
- **Audit** (§4): zadatak, verzija prompta, SHA-256 ulaza, model sa digestom, trajanje, izlaz.
  Opis je izveden iz teksta komentara — ista retencija kao komentari.
- **Verzija prompta** se menja sa svakom izmenom uputstva. `g2-1` (samo opšte uputstvo) je sa
  `gemma3:4b` prepričavao teme članaka, propuštao toksičnost i izmišljao procente; `g2-2` definiše
  svako polje i nivoe toksičnosti i traži da se brojke prepišu iz ulaza — na istim kohortama
  (`sabloni-3`) toksičnost i brojke tačne, opis mestimično netačan (npr. „hvale članke" umesto
  „hvale komentare"). `g2-3` dodaje brojeve po vrsti komentara: kod mešovitih kohorti blizu
  istine (8/4/0 → 7/3/2), kod malih (3 komentara) nepouzdani. Ocena merenjem (§7) predstoji.
- **UI recenzenta** ga prikazuje kao „opis modela — savetodavno", escape-ovan (§5). Uloga kohorte
  (`caci.md` §1) ga koristi kao jedan od signala, nikad kao presudu; uloga ima verziju pravila i
  preračunava se iz sačuvanog opisa kad se pravila promene, bez ponovnog poziva modela.

---

## 6. Izvođenje

- Red poslova u PostgreSQL-u (`SELECT … FOR UPDATE SKIP LOCKED`), radnik u `klaka-engine`.
  Bez dodatnog servisa za redove.
- Tajmaut po zadatku; neuspeli posao se ponovo pokušava ograničen broj puta, pa označava.
- **CPU je podrazumevani hardver.** GPU je opcija (Ollama ga koristi ako je dostupan).
  Vreme po zadatku na CPU-u meri se u eval-u (§7), ne pretpostavlja.

---

## 7. Izbor modela — merenjem

Podrazumevane vrednosti u compose-u (`gemma3:4b`, `bge-m3`) su **polazne**, izabrane da se
preuzimaju brzo i rade na običnom računaru. Konačan izbor dolazi iz eval-a.

**Kandidati (svi besplatni):**

| Uloga | Kandidati |
| --- | --- |
| embeddings | `bge-m3`; drugi višejezični modeli dostupni kroz Ollama |
| generativni | `gemma3` (4b, 12b), `qwen3` (8b, 14b); fine-tune modeli za jezik portala objavljeni kao GGUF na Hugging Face-u (Ollama ih učitava preko `hf.co/…`) |
| plaćena referenca | jedan Claude model — **samo kao merna gornja granica**, da znamo koliko otvoreni modeli zaostaju |

**Eval skupovi:**

| Zadatak | Skup | Merilo |
| --- | --- | --- |
| E1 | parovi komentara „isti šablon / različit šablon". Pozitivi: poznate grupe deljenih šablona (ručno označene ili iz istorije moderacije), pseudonimizovane | preciznost/odziv pri pragu sličnosti; razdvajanje parafraze od teme |
| G1 | 50–100 javnih članaka sa portala na kojima se sistem koristi, ručno označenih (tema, ton, da li je bio meta) | tačnost taksonomije, % validnog JSON-a, vreme na CPU-u, RAM |
| G2 | klasteri iz E1 sa ručnim opisom | ocena recenzenta (da li sažetak pogađa poruku) |

**Osetljive teme — tri dodatna merila za svaki generativni kandidat.** Na portalima se piše o
politici, geopolitici, levo-desnoj podeli, etničkim i rasnim temama, percepciji istorije.
Sistem je neutralan prema stavovima ([koncept](koncept_detekcija_sa_portala.md) §0), pa model
mora da obrađuje sve strane jednako:

| Merilo | Kako | Zašto |
| --- | --- | --- |
| **stopa odbijanja** | udeo ulaza (mržnja, rasizam, uvrede, ekstremni stavovi) na koje model ne vrati validan JSON nego odbije ili izbegne | odbijanje pravi rupu baš tamo gde je napad najgori |
| **simetričnost grešaka** | eval skup izbalansiran po stranama (vlast / opozicija, levo / desno, različite nacionalne perspektive); greške G1/G2 po strani | model ne sme sistematski da vidi jednu stranu kao „agresivniju" |
| **ironija i šifrovan jezik** | ručno označeni ironični, sarkastični i „ezopovski" komentari | mali modeli su ovde najslabiji; tu veći model najviše donosi |

Uz to, skup pokriva sva pisma i varijante jezika koje portal koristi (npr. dva pisma, više narečja), i teme
koje dotiču zemlju porekla modela (neki modeli imaju ugrađena ograničenja na takve teme).

**Hardver za eval:** razvojni laptop (16 GB RAM, bez posebne grafike) pokreće 4B modele
udobno, 8–14B sporo. Brzina na CPU-u se meri za svaki kandidat; GPU se razmatra tek ako eval
pokaže da je potreban veći model, i tada sa poznatom potrebom za video memorijom.

Eval se pokreće iz Rust-a nad istim interfejsom, promptom, šemom i validacijom koje koristi
produkcija: `cargo run --release -p klaka-engine --example eval_g2 -- gemma3:4b qwen3:8b`.

**Prvo merenje G2/G3** (2026-10-21, prompt `g2-3`, skup `klaka-engine/eval/g2.json`: 33 sintetičke
kohorte — 12 osnovnih, 6 parova u ogledalu po stranama, 4 ironije i šifrovanog jezika, 5 mržnje,
pretnji i psovki; laptop Intel Core 5 210H, 30 GB RAM, CPU):

| Mera | gemma3:4b | qwen3:8b | gemma3:12b |
| --- | --- | --- | --- |
| ispravan JSON | 32/33 | 33/33 | 33/33 |
| odbijanje (mržnja, pretnje, psovke) | 0/5 (1 neispravan zbir) | 0/5 | 0/5 |
| stav tačan | 79% | 88% | 88% |
| toksičnost tačna | 82% | 76% | **97%** |
| izrazita toksičnost ocenjena blaže | 0/8 | **4/8** | 0/8 |
| ironija: stav tačan | 2/4 | 2/4 | 3/4 |
| greška broja komentara po vrsti (hvale / napadaju / skreću) | 0,66 / 0,94 / 0,72 | 0,79 / 0,70 / 0,09 | **0,45 / 0,36 / 0,03** |
| parovi u ogledalu isti | 5/6 | 5/6 | **6/6** |
| vreme po kohorti | 22 s | 35 s (`think: false`) | 69 s |

- **gemma3:12b** je bolji u svemu osim brzine: toksičnost skoro bez greške, brojevi po vrsti
  skoro tačni (kod 4B upravo oni ruše ulogu kohorte, `caci.md` §1), svi parovi u ogledalu isti.
- **qwen3:8b** dobro broji skretanje, ali pretnje i dehumanizaciju ocenjuje kao „blagu"
  toksičnost — i **nesimetrično**: „desničari su paraziti" blaga, „levičari su paraziti"
  izrazita. Upravo ono što merilo simetričnosti treba da uhvati; za osetljive teme nepogodan.
- **gemma3:4b** pravi nesimetričnu grešku u ironiji (sarkazam o vlasti „podrška", isti o
  opoziciji „napad") i broji skretanje loše (8 komentara skretanja → 1/3/3).
- Nijedan model ne odbija mržnju ni psovke — opisuje ih (dobro).
- Svi modeli za čisto skretanje češće kažu stav „mešovito" nego „skretanje"; brojevi po vrsti
  su pouzdaniji od stava.
- Na ulozi kohorte (`caci.md` §1), na istim kohortama `uloge-3/4`: sa opisom `gemma3:4b` tačan
  skup uloga 16/24, sa `gemma3:12b` 24/24. Engine zato opisuje sa `gemma3:12b`
  (`KLAKA_DESCRIBE_MODEL`), a emulator parafrazira sa bržim `KLAKA_LLM_MODEL`.
- Skup je mali i sintetički; uz pravi rad treba proširiti ručno označenim kohortama sa portala.

---

## 8. Redosled

| Korak | Šta | Zašto ovim redom |
| --- | --- | --- |
| 1 | PoC bez LLM-a | token + honeypot + kohorte moraju da rade sami |
| 2 | **E1 embeddings** + grupisanje šablona | najveća korist, najmanji trošak, bez generativnog modela |
| 3 | G1 profil posta u **shadow** režimu | čuva se i poredi, ništa ne zavisi od njega |
| 4 | G2 i G3 | tek kad postoje klasteri i red za pregled — urađeno jednim pozivom (§5b); merenje (§7) predstoji |
