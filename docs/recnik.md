# Rečnik

Pojmovi projekta, redom kojim se pojavljuju u lancu: od onoga što se dešava na portalu do
presude. Gde pojam ima ime u kodu ili protokolu, ono je u zagradi.

## Lanac

1. **Poslušnici** i **publika** prave **akcije** na **metama**; uz akcije stižu i ostali
   **događaji** (prikaz, čitanje, pisanje).
2. **Detektori** grupišu akcije u **kohorte**, svaki po jednoj **dimenziji**.
3. **Engine** traži **presek** kohorti — iste akcije u kohortama više dimenzija, na istim metama,
   kroz više postova — i odbacuje one koje objašnjava **legitimni blizanac**.
4. **Recenzent** potvrđuje ili odbacuje kohortu; LLM mu opisuje dokaze, ne odlučuje.
5. Potvrđena kohorta postaje **presuda**; SDK je primenjuje kao **odluku** za svaku sledeću akciju.

## Akteri

| Pojam | Značenje |
| --- | --- |
| **klaka** | pojava: plaćeno lažiranje publike glasovima i komentarima ([README](../README.md#zašto-klaka)) |
| **poslušnik** | član klake: glasa i komentariše po naređenju, za sitnu korist; tri uloge ispod ([`caci.md`](caci.md) §1) |
| **pojačivač** | poslušnik koji gura: glasovi „za", pohvale, utisak većine; nije toksičan |
| **ćaci** | zli ljudski bot: toksičan poslušnik — vređa, ruši raspravu, potiskuje i napada autore |
| **razvodnjivač** | poslušnik koji gasi vruću temu gomilom praznih ili skrenutih komentara |
| **publika** (čitalac) | legitimni posetioci; jedino mesto gde se mere lažni pozitivi |
| **legitimni blizanac** | legitimna pojava koja liči na napad: push, naslovna, javno deljenje, CGNAT (koncept §8) |
| **recenzent** | čovek na strani portala ili sistema koji potvrđuje ili odbacuje kohortu i time daje oznake |

Uloge poslušnika se definišu ponašanjem, ne stranom.

## Podaci

| Pojam | Značenje |
| --- | --- |
| **prikaz** (`vid`) | jedno učitavanje posta u browseru; `vid` izdaje `klaka-api` uz **token pregleda** ([`token.md`](../core/spec/token.md)) |
| **događaj** (event) | atomska jedinica koju prima `klaka-collector`: iz browsera (`view`, `engage`, `compose`, `honeypot`) ili sa backenda portala (`vote`, `comment`, `moderation`, `post`, `promotion`) ([`events.md`](../core/spec/events.md)) |
| **akcija** | događaj kojim posetilac menja javni sadržaj — **glas** ili **komentar**. Samo akcije se broje ili idu u `shadow`; ostali događaji su njihova obeležja (spajaju se preko `vid`) |
| **meta** (`target`, `target_author`, `post`) | na šta je akcija usmerena: komentar, **autor komentara** (pseudonim) ili post |
| **mrežni prefiks** (`net`) | IPv4 /24 ili IPv6 /48 klijenta; pun IP se nigde ne čuva |

## Analiza

| Pojam | Značenje |
| --- | --- |
| **obeležje** | vrednost akcije po kojoj se grupiše: prefiks, meta, šablon teksta, vreme, referer, obrazac čitanja |
| **dimenzija** | vrsta obeležja; šest: vremenska, tekstualna, bihevioralna, ciljna, mrežna, izvorna (koncept §2a) |
| **detektor** | deo `klaka-engine`-a za jednu dimenziju: od akcija u prozoru pravi kandidatske kohorte |
| **kohorta** | skup **akcija** (ne ljudi) povezanih jednim zajedničkim obeležjem u vremenskom prozoru (koncept §2a) |
| **presek** | iste akcije u kohortama više dimenzija; tek presek, ponovljen kroz postove, je dokaz koordinacije (koncept §2a, pravilo preseka) |
| **uloga kohorte** | pojačivači, ćaci ili razvodnjivači — po efektu na raspravu; za recenzenta i izveštaj, nikad za presudu ([`caci.md`](caci.md) §1) |

## Ishod

| Pojam | Značenje |
| --- | --- |
| **presuda** (verdict) | zaključak engine-a o kohorti, upisan u Valkey po prefiksu, `vid`-u ili `cid`-u: `none`, `shadow`, `challenge`, sa rokom važenja ([`verdicts.md`](../core/spec/verdicts.md)) |
| **odluka** (`decision`) | šta SDK uradi sa jednom akcijom: `count` ili `shadow` ([`sdk.md`](../core/spec/sdk.md) §2) |
| **shadow** | akcija se čuva i prikazuje onome ko ju je napravio, ali se ne računa u javni zbir; odgovor je isti kao za `count`. Klaka nikad ne blokira |
| **pomeraj javnog zbira** | koliko je kampanja pomerila javni brojač meta — glavno merilo uspeha klake, pa i Klake ([`caci.md`](caci.md) §7) |
