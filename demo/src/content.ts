// Sadržaj portala: članci po rubrikama i početni komentari. Isti komentatori se javljaju na
// više postova, kao na pravom portalu — ciljna dimenzija (koncept §2a) traži baš to: iste mete
// (autore komentara) kroz postove. Prva četiri članka su pisana ručno (na njih ciljaju caci
// profili, `c1`–`c16`); ostale je jednom napisao lokalni LLM (`scripts/write-articles.mjs`,
// `content/articles.json`) — neutralne vesti iz izmišljenog grada.

import { readFileSync } from "node:fs";
//
// Članci su dužine kao na pravom portalu: komentari nisu na prvom ekranu, pa `seen` znači da je
// čitalac stvarno stigao do njih (core/spec/events.md §2).

export interface Post {
  id: string;
  section: string;
  title: string;
  /** Uvod ispod naslova (generisani članci). */
  lead?: string;
  paragraphs: string[];
}

export interface Section {
  /** Kao u `Post.section` i u `post` događaju. */
  id: string;
  /** U adresi: `/r/<slug>`. */
  slug: string;
  name: string;
}

export const SECTIONS: Section[] = [
  { id: "grad", slug: "grad", name: "Grad" },
  { id: "kultura", slug: "kultura", name: "Kultura" },
  { id: "saobraćaj", slug: "saobracaj", name: "Saobraćaj" },
  { id: "sport", slug: "sport", name: "Sport" },
  { id: "ekonomija", slug: "ekonomija", name: "Ekonomija" },
];

export interface SeedComment {
  post: string;
  id: string;
  author: string;
  text: string;
  /** ID komentara na koji odgovara. */
  reply_to?: string | null;
}

const WRITTEN: Post[] = [
  {
    id: "p-1001",
    section: "grad",
    title: "Park kod reke dobija novu stazu i klupe do proleća",
    paragraphs: [
      "Radovi na uređenju parka počinju sledeće nedelje. Predviđene su nova pešačka staza, rasveta i trideset klupa. Gradska uprava navodi da će park tokom radova biti delimično otvoren.",
      "Stanari okolnih zgrada traže i češće odnošenje smeća, a udruženje vlasnika pasa poseban ograđen prostor. O oba zahteva odlučivaće se na sednici u decembru.",
      "Prema projektu, staza će biti široka tri metra i povezaće oba ulaza u park. Uz nju je predviđeno četrdeset novih stubova javne rasvete sa štedljivim sijalicama, kao i česme na tri mesta. Postojeća dečja igrališta ostaju, ali će dobiti novu podlogu.",
      "Izvođač je izabran na tenderu na kome su učestvovale tri firme. Vrednost radova je u okviru budžeta usvojenog početkom godine, a rok za završetak je kraj marta. Ako vreme dozvoli, prvi deo staze biće otvoren već pre novogodišnjih praznika.",
      "Tokom radova biće zatvoren severni ulaz, pa se šetačima savetuje da koriste ulaz kod mosta. Parking uz park ostaje dostupan, osim u danima kada se dovozi materijal; o tim danima stanari će biti obavešteni na oglasnim tablama.",
      "U gradskoj upravi kažu da je ovo prvi od tri parka koji će biti uređeni u narednih godinu dana. Za ostala dva projekti su u izradi, a javna rasprava o njima biće održana na proleće, kada će građani moći da predlože šta im je najpotrebnije.",
      "Udruženje stanara pozdravilo je početak radova, ali traži da se sačuva što više starih stabala. Iz uprave odgovaraju da je projektom predviđeno uklanjanje samo bolesnih stabala i da će za svako posečeno biti zasađeno novo.",
    ],
  },
  {
    id: "p-1002",
    section: "kultura",
    title: "Gradska biblioteka od novembra radi i nedeljom",
    paragraphs: [
      "Centralno odeljenje gradske biblioteke od prvog novembra biće otvoreno i nedeljom, od deset do šesnaest časova. Odluka je doneta posle ankete u kojoj je većina članova tražila duže radno vreme vikendom.",
      "Nedeljom će raditi čitaonica, pozajmno odeljenje i dečji kutak. Odeljenje periodike i zavičajna zbirka ostaju zatvoreni, jer za njih nema dovoljno zaposlenih koji bi radili u smenama.",
      "Biblioteka je prošle godine imala nešto više od devet hiljada aktivnih članova, što je za petinu više nego pre tri godine. Najviše su porasli upisi učenika srednjih škola, koji čitaonicu koriste za učenje pred ispite.",
      "Uz novo radno vreme biblioteka uvodi i elektronsko produžavanje pozajmice preko sajta. Članovi će knjige moći da produže dva puta, svaki put za po dve nedelje, ako ih u međuvremenu niko nije rezervisao.",
      "Članarina se ne menja. Penzioneri, studenti i nezaposleni i dalje plaćaju umanjenu godišnju članarinu, a deca do sedme godine upisuju se besplatno uz roditelja koji je član biblioteke.",
      "Direktorka biblioteke kaže da će probni period trajati do kraja školske godine. Ako se pokaže da nedeljom dolazi malo posetilaca, radno vreme biće skraćeno ili premešteno na subotu popodne.",
      "U planu je i obnova čitaonice na drugom spratu, za koju je biblioteka konkurisala kod ministarstva. Ako sredstva budu odobrena, radovi bi se izvodili tokom leta, kada je poseta najmanja.",
    ],
  },
  {
    id: "p-1003",
    section: "saobraćaj",
    title: "Autobuska linija 14 od decembra ide do novog naselja",
    paragraphs: [
      "Linija 14 gradskog prevoza biće od prvog decembra produžena do novog naselja na istočnom obodu grada. Trasa se produžava za oko dva kilometra, a na njoj će biti četiri nova stajališta.",
      "Stanari naselja do sada su do najbliže linije pešačili petnaestak minuta, uz prometan put bez trotoara. Zahtev za produženje linije potpisalo je više od osamsto građana tokom leta.",
      "Prevoznik najavljuje da će autobusi radnim danima saobraćati na dvadeset minuta u jutarnjoj i popodnevnoj špici, a na četrdeset minuta van nje. Vikendom će polasci biti na svakih sat vremena.",
      "Zbog dužeg puta na liniju se uvode još dva vozila. Prevoznik kaže da će to biti novi autobusi sa niskim podom, pogodni za kolica i osobe sa invaliditetom, nabavljeni ove godine.",
      "Cena karte se ne menja, a mesečne karte važiće na celoj trasi. Stajališta u naselju za sada će biti označena privremenim stubovima, dok se ne izgrade nadstrešnice predviđene za proleće.",
      "Saobraćajna služba upozorava da će tokom prve nedelje na novim stajalištima biti dežurni radnici prevoznika, koji će putnicima objašnjavati novi red vožnje i deliti štampane rasporede.",
      "U istom paketu izmena linija 9 dobija polaske i posle ponoći petkom i subotom, na zahtev ugostitelja iz centra i radnika koji rade u noćnoj smeni.",
    ],
  },
  {
    id: "p-1004",
    section: "grad",
    title: "Zelena pijaca dobija nadstrešnicu i nove tezge",
    paragraphs: [
      "Na Zelenoj pijaci ove zime biće postavljena nadstrešnica nad celim prodajnim prostorom i sto dvadeset novih tezgi. Pijaca će tokom radova raditi u skraćenom obimu, na privremenim tezgama uz zapadnu ogradu.",
      "Prodavci već godinama traže zaštitu od kiše i sunca. Stara nadstrešnica pokrivala je samo trećinu pijace, pa su prodavci leti donosili sopstvene suncobrane, a zimi su mnogi prestajali da dolaze.",
      "Nove tezge biće od nerđajućeg čelika, sa priključkom za struju i vodu na svakih deset tezgi. Predviđeni su i rashladni pultovi za mlečne proizvode, koji su do sada mogli da se prodaju samo u zatvorenom delu pijace.",
      "Zakup tezge ostaje isti do kraja godine. Od januara će cena zavisiti od položaja tezge, a prodavci koji su na pijaci duže od deset godina imaće prednost pri izboru mesta.",
      "Javno preduzeće koje upravlja pijacama kaže da će radovi trajati oko dva meseca. Najveći deo posla obaviće se noću i ponedeljkom, kada je pijaca inače zatvorena za kupce.",
      "Udruženje proizvođača iz okolnih sela pozdravilo je obnovu, ali traži da deo tezgi bude rezervisan samo za one koji prodaju sopstvene proizvode, a ne robu kupljenu na veletržnici.",
      "Iz preduzeća odgovaraju da će takve tezge biti posebno označene i da će prodavci na njima morati da pokažu potvrdu o registrovanom poljoprivrednom gazdinstvu.",
    ],
  },
];

/** Početni komentari, po postu. ID-jevi su jedinstveni na celom portalu. */
const WRITTEN_COMMENTS: SeedComment[] = [
  { post: "p-1001", id: "c1", author: "Milica", text: "Konačno! Staza je bila u očajnom stanju." },
  { post: "p-1001", id: "c2", author: "Dragan", text: "Klupe su lepe, ali ko će održavati rasvetu?" },
  { post: "p-1001", id: "c3", author: "Jelena", text: "Ograđen prostor za pse bi rešio dosta sukoba." },
  { post: "p-1001", id: "c4", author: "Stefan", text: "Nadam se da radovi neće trajati do leta." },
  { post: "p-1002", id: "c5", author: "Ana", text: "Nedelja je jedini dan kad stignem da dođem, odlično." },
  { post: "p-1002", id: "c6", author: "Milica", text: "Elektronsko produžavanje je trebalo uvesti odavno." },
  { post: "p-1002", id: "c7", author: "Dragan", text: "Zašto zavičajna zbirka ostaje zatvorena baš kad ljudi imaju vremena?" },
  { post: "p-1002", id: "c8", author: "Nikola", text: "Čitaonica je pred ispite puna već u osam ujutru." },
  { post: "p-1003", id: "c9", author: "Dragan", text: "Dvadeset minuta u špici je i dalje malo za toliko stanova." },
  { post: "p-1003", id: "c10", author: "Vesna", text: "Bez trotoara do stanice je bilo opasno, dobro je da se ovo rešava." },
  { post: "p-1003", id: "c11", author: "Milica", text: "Niskopodni autobusi znače mnogo roditeljima sa kolicima." },
  { post: "p-1003", id: "c12", author: "Marko", text: "Noćni polasci na liniji 9 su važniji od svega ostalog." },
  { post: "p-1004", id: "c13", author: "Jelena", text: "Rashladni pultovi su dobra ideja, leti se sir kvari za sat." },
  { post: "p-1004", id: "c14", author: "Stefan", text: "Dva meseca radova pred praznike, baš u najgore vreme." },
  { post: "p-1004", id: "c15", author: "Ana", text: "Tezge za domaće proizvođače treba da budu bliže ulazu." },
  { post: "p-1004", id: "c16", author: "Vesna", text: "Nadam se da cene zakupa neće oterati male prodavce." },
];

interface Generated {
  id: string;
  section: string;
  title: string;
  lead: string;
  paragraphs: string[];
  comments: { author: string; text: string; reply_to: number | null }[];
}

/** `content/articles.json`; bez njega portal ima samo ručno pisane članke. */
function generated(): Generated[] {
  try {
    return JSON.parse(readFileSync(new URL("../content/articles.json", import.meta.url), "utf8")) as Generated[];
  } catch {
    return [];
  }
}

const GENERATED = generated();

export const POSTS: Post[] = [...WRITTEN, ...GENERATED.map(({ comments: _, ...post }) => post)];

/** Početni komentari; ID-jevi generisanih su `c-<post>-<n>`, jedinstveni na celom portalu. */
export const SEED_COMMENTS: SeedComment[] = [
  ...WRITTEN_COMMENTS,
  ...GENERATED.flatMap((a) =>
    a.comments.map((c, i) => ({
      post: a.id,
      id: `c-${a.id}-${i + 1}`,
      author: c.author,
      text: c.text,
      reply_to: c.reply_to === null ? null : `c-${a.id}-${c.reply_to + 1}`,
    })),
  ),
];

export const sectionOf = (id: string): Section | undefined => SECTIONS.find((s) => s.id === id);
