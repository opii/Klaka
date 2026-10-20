# LLM sloj — plan

**Status:** plan, nije implementirano. **Vezano:** [`koncept_detekcija_sa_portala.md`](koncept_detekcija_sa_portala.md) §5,
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
  PRIMARY KEY (portal, comment)
);
CREATE INDEX ON comment_embedding USING hnsw (emb halfvec_cosine_ops);

-- kandidati za „isti šablon, druge reči": najbliži komentari na DRUGIM postovima, 7 dana
SELECT comment, post, emb <=> $1 AS dist
FROM comment_embedding
WHERE portal = $2 AND post <> $3 AND model = $4 AND t > now() - interval '7 days'
ORDER BY emb <=> $1
LIMIT 20;
```

- Tok: komentar stigne → posao u redu → Ollama `/api/embed` → upis → kNN upit → parovi
  ispod praga postaju ivice „deljeni šablon" u grafu kohorte.
- **MinHash ide prvi** (Rust, bez modela): copy-paste i sitne izmene hvata jeftino. Embeddings
  dodaju parafraze.
- `halfvec` = upola manje prostora od `vector`, uz zanemarljiv gubitak tačnosti za kosinus.
- Prag udaljenosti se određuje u eval-u (§7), ne unapred. Orijentir sa prvog testa (2026-10-20):
  parafraza napada 0,108, nepovezana rečenica 0,629.
- **Embeddings su izvedeni iz ličnih podataka** (tekst se iz njih delimično može rekonstruisati)
  → ista retencija kao komentari, brišu se zajedno.
- Promena embeddings modela = novi vektori za sve komentare u retenciji (zato kolona `model`).

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

Eval se pokreće iz Rust-a (`cargo run -p klaka-llm --example eval`) nad istim interfejsom koji
koristi produkcija.

---

## 8. Redosled

| Korak | Šta | Zašto ovim redom |
| --- | --- | --- |
| 1 | PoC bez LLM-a | token + honeypot + kohorte moraju da rade sami |
| 2 | **E1 embeddings** + grupisanje šablona | najveća korist, najmanji trošak, bez generativnog modela |
| 3 | G1 profil posta u **shadow** režimu | čuva se i poredi, ništa ne zavisi od njega |
| 4 | G2 i G3 | tek kad postoje klasteri i red za pregled |
