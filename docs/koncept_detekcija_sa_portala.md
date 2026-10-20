# Koncept: detekcija koordinisanih napada isključivo iz podataka portala

**Status:** radni koncept, polazna tačka. Menja se usput.
**Datum:** 2026-10-20 (dopunjeno istog dana posle pregleda, vidi §7–§11)

Polazna pretpostavka: **nemamo interne podatke napadača.** Imamo samo ono što portal može sam
da prikupi i razume.

---

## 0. Pravilo igre

Sve što sistem koristi mora da potiče iz jednog od ovih izvora:

- serverski logovi portala (zahtevi, referer, IP → /24 + ASN + država, user-agent);
- događaji sa stranice koje portal sam meri (prikaz, skrol, vreme na strani, klik, glas, komentar);
- sadržaj komentara i pseudonimi pod kojima su objavljeni;
- **odluke moderatora** (pušten / odbijen komentar, sa vremenom) — vidi §6;
- mere koje portal sam aktivno postavi (tokeni, honeypot elementi, varijante URL-ova).

**Neutralnost prema stavovima.** Sistem otkriva **koordinaciju, ne mišljenje**. Na portalima
se raspravlja o politici, geopolitici, levo-desnoj podeli, etničkim i rasnim temama, istoriji —
i nijedan stav sam po sebi nije signal. Konkretno:

- nijedan detektor ne koristi to *šta* komentar tvrdi ni *koju stranu* zastupa; koristi
  ponašanje (kohorta, tempo, ponavljanje), infrastrukturu i *sličnost* poruka;
- LLM nikad ne procenjuje ko je u pravu, da li je nešto istina ili propaganda — samo „ovi
  komentari poručuju isto" i „ovako se odnose prema članku";
- ista koordinacija u korist bilo koje strane mora dati isti signal; to se meri (vidi
  [`llm.md`](llm.md) §7 i §11 ovde).

---

## 1. Osnovna ideja: rekonstruisati napadačevu evidenciju spolja

Organizovana mreža interno vodi evidenciju: ko je operater, koji je zadatak, kada je izdat,
kojom direktivom, sa koje mašine. Svaki od tih zapisa ostavlja **senku** u logovima portala.
Zadatak sistema je da tu evidenciju rekonstruiše spolja.

| Interno kod napadača | Šta portal vidi | Kako se rekonstruiše |
| --- | --- | --- |
| zadatak („idemo na ovu vest") | nagli početak koordinisane aktivnosti na postu | change-point detekcija: trenutak kad kohorta „uključi" post = **izvedeni zadatak** |
| operater | stotine pseudonima, kolačića, IP adresa | klasterovanje pseudo-identiteta u **izvedenog operatera** (stilometrija, uređaj, ritam) |
| zajedničko delovanje na iste mete | isti akteri na istim retkim postovima | bipartitni graf akter × post: diskriminativni postovi, Louvain, backbone |
| direktiva (šta i kako da se piše) | talas sličnih komentara istog stava | klasterovanje šablona + LLM stav → **izvedena direktiva** |
| raspored smena | satnica aktivnosti | kohorta pon–pet 08–16h, nezavisno od toga šta kaže GeoIP |
| ko prvi reaguje | ko uvek stiže prvi | isto, nad izvedenim operaterima |
| mašine za automatsko glasanje | glasovi iz neobičnih ASN-ova | klasterovanje infrastrukture (ASN × vremenski prozor × otisak klijenta) |
| izveštaj o broju glasova | odnos glasova i stvarnih čitanja | glasovi bez prethodnog prikaza stranice |

Posledica: model napadača postaje **specifikacija mete**, a ne podaci koji nam fale. Znamo
koju strukturu tražimo.

---

## 2. Invarijante napadača — šta ne može jeftino da sakrije

Prednost imaju signali koji napadača **koštaju**, ne oni koje zaobiđe jednom izmenom skripte.

1. **Ograničen broj ljudi.** Može imati 2.000 pseudonima, ali ne 2.000 ljudi koji pišu
   različito. Isti ljudi se vraćaju na mnogo postova → ponavljanje kohorte kroz postove je
   najjači i najteže sakriv signal.
2. **Reaguje na naredbu.** Organska publika stiže preko referera (Google, društvene mreže,
   naslovna strana). Koordinisana stiže u talasu, **sa istim refererom** (Viber/Telegram
   link) ili bez njega, često pravo na `#komentari`. *Oprez:* ovo deli sa legitimnom
   mobilizacijom — vidi §8.
3. **Radi po rasporedu.** Ljudi u smenama ostavljaju otisak radnog vremena; mašine koje se
   pale i gase po rasporedu ostavljaju svoj.
4. **Želi vidljiv rezultat.** Glas ima smisla samo ako se vidi na brojaču. To je poluga:
   rezultat možemo **pokazati bez uračunavanja**.

---

## 2a. Kohorte — osnovna jedinica analize

> **Kohorta** = skup **akcija** (ne ljudi) povezanih **jednim** zajedničkim obeležjem u
> vremenskom prozoru.

Kohorta je namerno skup akcija, a ne osoba: sistem ne gradi profile pojedinaca
(`cid` je opcion). Akcija se vezuje za prikaz (`vid`), mrežni prefiks, pseudonim i
vreme — to je dovoljno da se ista grupa prepozna kroz postove.

### Šest dimenzija i njihovi legitimni blizanci

| Dimenzija | Zajedničko obeležje | Primer napada | Legitiman blizanac |
| --- | --- | --- | --- |
| **vremenska** | nalet u uskom prozoru, relativno prema saobraćaju posta | 50 glasova na opskuran komentar za 3 s | push notifikacija, naslovna strana, newsletter (§8) |
| **tekstualna** | ista *formulacija* — parafraza (pgvector) ili kopija (MinHash) | šablon u deset varijanti reči | popularna fraza, citat iz članka, meme |
| **bihevioralna** | isti grub obrazac ponašanja (`engage`, `compose`) | nalepljen tekst bez kucanja; glas bez čitanja | ljudi sa istim uređajem i navikama |
| **ciljna** | iste mete: post, komentar **ili autor komentara** (pseudonim) | sistematsko spuštanje komentara istog komentatora kroz postove | ljudi koji prate istu temu ili istog komentatora |
| **mrežna** | /24 + ASN + klijent | stotine glasova iz jedne mreže | CGNAT mobilnog operatera, studentski dom, firma |
| **izvorna** | isti referer ili canary kanal | talas iz zatvorene Viber grupe | javni link na društvenoj mreži |

### Pravilo preseka (invarijanta 1, formalno)

Kohorta po **jednoj** dimenziji je samo **kandidat** — svaka ima legitimnog blizanca.
**Klaka** je presek: isti akteri (povezani kroz `vid`, prefiks, pseudonim) u kohortama
**≥ 2 nezavisne dimenzije**, i to **na više postova**. Nijedna presuda ne nastaje iz jedne
dimenzije.

Za engine to znači jednostavnu strukturu: detektori proizvode kohorte po dimenziji
(`cohort`, `cohort_member`), engine traži preklapanja i ponavljanje kroz postove.

### Tri napomene

- **Tekstualna ≠ ista misao.** Grupiše se **ista formulacija** (parafraza na kosinusnoj
  udaljenosti ~0,1), ne isti stav (tema je na ~0,3–0,4 i dalje). Hiljadu ljudi može nezavisno
  da misli isto — to nije koordinacija (§0, neutralnost).
- **Ciljna bez praćenja pojedinca.** Ne gleda se „istorija kretanja" jedne osobe kroz portal,
  nego udeo **u kohorti**: koliko je akcija stiglo direktno na komentare, bez referera i bez
  čitanja.
- **Jeftino pre skupog.** Kohorte se grade iz jeftinih metapodataka (vreme, mreža, mete,
  embeddings). Generativni LLM vidi samo kohorte koje su već prešle prag, i samo **opisuje**
  šta poručuju — ne presuđuje ([`llm.md`](llm.md) §0).

### Tri signala za bihevioralnu i ciljnu dimenziju

| Signal | Izvor | Zašto je jak | Šta se namerno NE meri |
| --- | --- | --- | --- |
| **glas na komentar koji nije bio na ekranu** | `engage.seen` — ID-jevi komentara koji su bili vidljivi | glasač je znao šta traži; skripta mora da imitira skrolovanje baš do tog komentara (headless browser umesto prostog HTTP zahteva) | putanja skrolovanja po pikselu |
| **kako je komentar nastao** | `compose` — fokus → slanje, broj tastera **u rasponu**, da li je nalepljen | nalepljen šablon bez kucanja je potpis operatera | vreme između tastera, putanja miša (biometrija — GDPR/ePrivacy) |
| **autor komentara kao meta** | `vote.target_author` (pseudonim autora komentara na koji se glasa) | koordinisano potiskivanje ili guranje konkretnog komentatora | — |

---

## 3. Aktivne mere — portal ne mora samo da posmatra

- **Token pregleda za glas.** Server pri renderovanju članka izdaje potpisan token sa
  vremenom. Glas bez važećeg tokena, ili sa tokenom starim 0,8 s, ne ulazi u brojač.
  „Glas bez čitanja" postaje pravilo, ne samo signal. Direktno pogađa automatsko glasanje
  preko `fetch`/`FormData` zahteva, bez učitavanja stranice.
- **Honeypot elementi.** Nevidljiva dugmad za glasanje i mamac-polja u formi za komentar.
  Čovek ih ne vidi; skripta koja traži elemente preko XPath-a ih klikne. Ovo je retka
  prilika za **pouzdan ground truth** — svaki takav klik je sigurno automatizacija.
- **Nasumičan DOM.** ID-jevi i struktura dugmadi menjaju se po prikazu. XPath skripte
  (`document.evaluate`) prestaju da rade; napadač mora stalno da ih održava.
- **Shadow counting.** Glasovi označene kohorte vide se samo njihovom izvoru, javni brojač
  ih ne računa. Napadač ne zna da je otkriven i ne prilagođava se. Bolje od blokade.
- **Canary linkovi.** Isti članak dobija različite URL varijante po kanalu (push, RSS,
  društvene mreže). Kad talas stigne preko varijante koja je „procurela" u zatvoreni kanal,
  znaš i kojim kanalom je zadatak distribuiran.

Praktične zamke svake od ovih mera su u §10.

---

## 4. Saradnja više portala

Svaki portal vidi samo svoj deo. Razmena indikatora — **samo heševi, bez ličnih podataka**:

- MinHash otisci šablona komentara;
- prozori ASN × vreme sa neobičnom aktivnošću;
- otisci klijenata (heširani).

Šablon koji se istog dana pojavi na pet portala jači je dokaz od bilo čega što jedan portal
vidi sam.

---

## 5. Uloga LLM-a

Profil posta (LLM pre objave) ima ovu ulogu:

- **Prior da je post meta.** Napadač bira mete po političkom ključu; model pre objave
  procenjuje koliko je post verovatna meta i u kom smeru (pojačavanje vs napad). Razlika
  između procene i onoga što se desi je informacija.
- **Klasterovanje parafraziranih šablona.** MinHash hvata copy-paste; embeddings + stav
  hvataju „istu direktivu, drugim rečima".
- **Sažetak za recenzenta.** „Ova grupa se pojavila na 14 postova, uvek u prvih 6 minuta,
  isti stav."

---

## 6. Evaluacija — portal već ima označene podatke

Portali koje mreža zasipa komentarima često odbijaju veliki deo tih komentara već u
moderaciji. Drugim rečima, **moderatori portala godinama svakodnevno proizvode oznake**: pušten /
odbijen komentar, sa vremenom, pseudonimom, IP-om. To je veliki, šumovit, ali stvaran skup
pozitiva iz pravog saobraćaja. Ne mora se simulirati.

Tri izvora oznaka, po pokrivenosti:

| Izvor | Šta pokriva | Šta ne pokriva |
| --- | --- | --- |
| **Istorija moderacije** | i automatizaciju i **ljude u smenama** (verovatno najvažniji oblik napada) | glasove (moderator ih ne vidi); šum: moderator odbija i legitimne uvrede |
| Honeypot klikovi, glasovi bez tokena | čiste oznake automatizacije | ljude — operater u smeni nikad ne klikne honeypot |
| Simulator napadača (obrasci: latencije, smene, pseudonimi, šabloni, ASN miks) | kontrolisani eksperimenti, pokrivenost retkih scenarija | realizam — simulacija zna samo ono što smo mi znali |

Lažni pozitivi se mere isključivo na legitimnoj publici portala — to je jedino mesto gde
postoje.

**Posledica za redosled rada:** prvi korak ne traži nikakvu novu telemetriju. Graf kohorte
(§1) se prvo pokreće **retroaktivno** nad istorijom komentara i odluka moderatora jednog
portala. Ako tamo ne izroni struktura (kohorte koje se vraćaju, šabloni, smene), ni
realnovremenski sistem je neće naći.

---

## 7. Dva problema, ne jedan: glasovi i komentari

Glasovi i komentari dele napadača, ali ne i signale ni mere. Treba ih voditi kao **dva
cevovoda sa zajedničkim slojem kohorte**:

| | **Glasovi** | **Komentari** |
| --- | --- | --- |
| Priroda | anonimni, jeftini, masovni, bez teksta | tekst + pseudonim, manji obim |
| Primarni signali | token pregleda, odnos glas/prikaz, infrastruktura (ASN × vreme × klijent), honeypot | šabloni (MinHash), stilometrija, pseudonimi, ponavljanje kohorte, odluke moderatora |
| Ground truth | honeypot, token | istorija moderacije |
| Mera | shadow counting, proof-of-work | red za pregled; nikad automatsko brisanje |
| Zajedničko | → sloj kohorte: isti /24 + otisak + ritam na oba cevovoda | ← |

**Fork koji treba razrešiti pre gradnje:** da li portal dozvoljava **anonimne komentare sa
slobodnim imenom** (pseudonim koji se upisuje uz svaki komentar) ili traži **nalog**?

- *Anonimni:* pseudo-identitet se gradi samo od kolačića, otiska uređaja, /24 i stila;
  klasterovanje je težak problem i jezgro §12.
- *Registrovani:* postoji graf naloga; problem je lakši i bliži klasičnom sockpuppet
  otkrivanju (vreme registracije, zajednički uređaji, životni ciklus naloga).

Dok se ne odluči za koji portal gradimo, dokument pretpostavlja **anonimni** slučaj kao teži.

---

## 8. Katalog legitimnih pojava koje liče na napad

Najčešći način da ovakav sistem napravi štetu je da **legitimnu mobilizaciju** proglasi
koordinacijom. Svaki signal ima legitimnog blizanca:

| Signal | Legitimna pojava koja ga imitira | Šta ih razdvaja |
| --- | --- | --- |
| talas sa istim refererom, isti stav, isti minut | političar podeli link na Tviteru; sindikat pošalje newsletter; Reddit nit | kohorta se **ne vraća** na deset drugih postova iste nedelje; pseudonimi stabilni; nema šablona; referer je javan kanal |
| masa iz jedne države van baseline-a | dijaspora; tekst o domaćem sportisti koji igra u inostranstvu | rezidencijalni ASN + normalno čitanje (dwell, skrol) + lokalni dnevni ritam te zemlje |
| aktivnost pon–pet 08–16h | ljudi koji čitaju vesti na poslu | kod čitalaca ritam prati portal u celini; kod smena ritam prati **kohortu**, a ne portal |
| mnogo komentara sa jednog /24 | CGNAT mobilnog operatera, studentski dom, firma | raznolik stil, raznolik dwell, nema sinhronije |
| slični komentari | popularna fraza, citat iz teksta, meme | sličnost **preko postova** i preko dana, ne unutar jednog posta |
| nagli skok glasova | tekst stvarno postao viralan | glasovi prate prikaze; token važeći; raznolikost klijenata |
| nalet čitanja i glasova u istom minutu | **portal sam** pošalje push notifikaciju, stavi tekst na naslovnu, pošalje newsletter | portal javlja trenutak promocije (`promotion` događaj); dolasci imaju referer naslovne ili push kanala; ljudi čitaju (`engage`); kohorta se ne vraća na druge postove |
| glas bez čitanja | čitalac se vratio na već pročitan tekst samo da glasa | `seen` sadrži komentar (vidljiv u tom prikazu); jedan glas, ne serija |

Tvrdo pravilo: nijedan geografski ili vremenski signal sam ne
pokreće meru. Mora ga pratiti bihevioralni (ponašanje unutar kohorte) ili infrastrukturni.

---

## 9. Tabela cene za napadača

Prioritet mera se određuje po tome **šta napadača košta posle njegovog najjeftinijeg
odgovora**, a ne po tome šta je nama lako da napravimo.

| Mera | Najjeftiniji odgovor napadača | Preostala cena za napadača |
| --- | --- | --- |
| token pregleda | učitati celu stranicu pre svakog glasa | ~10–50× više saobraćaja po glasu; glas više nije „besplatan" `fetch` |
| honeypot | vizuelna detekcija elemenata (screenshot + OCR / računarski vid) | sa „jedna XPath skripta za sve" na „održavanje po portalu i po redizajnu" |
| nasumičan DOM | isto kao gore, ili ciljanje po tekstu dugmeta | stalno održavanje; svaki redizajn portala obara skriptu |
| shadow counting | poređenje brojača iz dva izvora (jedan „čist", jedan iz kohorte) | otkrivanje traži disciplinu i vreme; dok ne otkrije, troši ljude na ništa |
| ponavljanje kohorte | **više ljudi**, raznolikiji raspored | nema jeftinog odgovora — ovo je invarijanta 1 |
| šabloni (MinHash) | parafraziranje (ručno ili LLM) | LLM parafraza je jeftina → zato embeddings + stav u §5 |
| stilometrija | LLM piše sve komentare | gubi se „ljudski" ton; i sam LLM-stil je prepoznatljiv |

Zaključak tabele: aktivne mere iz §3 dižu cenu automatizaciji, a jedino **graf kohorte** diže
cenu ljudima. Zato su u jezgru (§13) i jedno i drugo.

---

## 10. Praktične zamke aktivnih mera

- **Token po prikazu ruši CDN keš članka.** Ne sme biti u HTML-u koji se kešira. Izdaje
  se iz posebnog laganog endpointa (ili na edge-u) koji klijentska skripta pozove posle
  učitavanja.
- **Nasumičan DOM** ima isti sudar sa keširanjem, plus lomi analitičke i A/B alate koji
  gađaju selektore. Realno se izvodi **na klijentu posle učitavanja**, ne na serveru.
- **Honeypot elementi** moraju imati `aria-hidden="true"` i `tabindex="-1"`, inače ih
  čitači ekrana izlože korisniku i slepe korisnike označimo kao botove. Takođe ne smeju
  biti u fokusnom redosledu tastature.
- **Token ne eliminiše napad, samo diže cenu** (§9). Cilj mere je poskupljenje, ne blokada.
  Očekivati da napadač pređe na puno učitavanje stranice i planirati da to vidimo kao novi
  signal (odnos prikaz/glas naglo postaje „savršen").
- **Canary linkovi** ne smeju da razbiju kanonski URL (SEO) — varijante preko parametra
  uz `rel=canonical`, ne preko različitih putanja.
- **Shadow counting** mora biti dosledan po izvoru kroz vreme; ako isti klijent jednom vidi
  „čist" a jednom „svoj" brojač, mera je otkrivena.

---

## 11. Merila uspeha

Sistem bez merila je mišljenje. Tri merila, sva merljiva od prvog dana:

1. **Preciznost reda za pregled** — udeo prijavljenih kohorti koje recenzent potvrdi.
   Ispod ~50% recenzenti prestaju da gledaju red (poznati način umiranja ovakvih sistema).
2. **Vreme do signala** — od početka talasa (change-point) do prvog signala u redu.
   Meri se na retroaktivnim podacima (§6) pre nego što išta radi uživo.
3. **Cena po uspelom glasu/komentaru za napadača** — procena iz §9, pre i posle svake mere.
   Ovo je jedino merilo koje kaže da li menjamo napadačevu ekonomiju, a ne samo našu
   statistiku.

Dodatno, za §8: **stopa lažnih pozitiva na poznatim legitimnim mobilizacijama** (ručno
označeni događaji — npr. dan kad je opozicioni lider podelio tekst).

I, za neutralnost (§0): **simetričnost signala po stranama** — na simuliranim kampanjama iste
jačine u korist različitih strana (vlast / opozicija, levo / desno, različite nacionalne
perspektive) sistem mora dati statistički isti signal.

---

## 12. Početno jezgro

1. **Retroaktivna analiza istorije komentara + odluka moderatora** (§6) — bez nove
   telemetrije, odgovara na pitanje „postoji li struktura u podacima".
2. **Token pregleda za glas** (§3, §10)
3. **Honeypot elementi** (§3, §10)
4. **Graf ponavljanja kohorte nad pseudo-identitetima** (§1, §7)

Prvo je dijagnostika i ne košta ništa osim pristupa podacima. Drugo i treće su jeftini,
odmah daju pouzdane oznake i teško im se prilagoditi. Četvrto hvata ljude u smenama, koje
fingerprint nikad ne uhvati.

---

## 13. Otvorena pitanja

- **Anonimni ili registrovani komentari** na ciljnom portalu (§7) — određuje ceo pristup
  klasterovanju.
- Kako tačno klasterovati pseudo-identitete u izvedene operatere (signali, težine, prag)?
  Napomena: komentari su kratki, stilometrija je slaba na kratkom tekstu; kod organizovanih mreža
  verovatno dominira šablonski tekst, pa je near-duplicate primarno, stil sekundarno.
- Minimalna telemetrija koju portal mora da uvede i šta od toga traži pravnu proveru
  (ePrivacy za otisak uređaja).
- Shadow counting bez otkrivanja (§10, poslednja stavka).
- Format i upravljanje razmenom indikatora između portala (§4).
- Ko je prvi portal-partner i da li možemo dobiti istoriju moderacije za §12 korak 1.
