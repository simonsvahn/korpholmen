# KBK Klubbhistorik

Appens avsedda lager, tidsaxlar, granskningsflöde och framtida utbyggnad finns
i [`ARKITEKTUR.md`](ARKITEKTUR.md). Ansvarsfördelningen mellan alla appar finns
i [`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

Lokal-först-app för Korpholmens Båtklubbs medlems- och båthistorik. Appen
bevarar varje källrad och håller den åtskild från tolkningen. Den länkar
godkända förekomster till Matrikelns stabila person-ID och Båtregistrets
stabila båt-ID, men skriver inte automatiskt tillbaka till dessa mastrar.
Normaliserade vyer läser personens aktuella namn skrivskyddat från Matrikel;
`person_name_raw` och källayouten förblir bundna till den historiska utgåvan.

Mastern omfattar 14 årsvisa originalmatriklar från juli 1980 till augusti
2025, inklusive den tvåsidiga medlemsmatrikeln 2010. Före dessa ligger en
separat, uttryckligen märkt **grundarmatrikel (rekonstruktion)** för cirka
1945. Den bygger på fem redovisade källor och är inte ett påstående om att ett
sådant originaldokument har bevarats. I de
historiska matriklarna bevaras medlems- och fartygskolumnen var för sig och
sammanförs för källvisning med ett separat, källkontrollerat layoutlager,
inklusive passiva, juniorer, korresponderande och avregistrerade/namnändrade
fartyg där källan har sådana avsnitt. Kolumnerna är självständiga i källan;
appen påstår därför inte att en båt på en viss rad ägdes av personen på
motsvarande rad.
2010 års källa saknar fartygskolumn; det bevaras som en källegenskap och
tolkas inte som att klubben saknade båtar.

Vyn **Medlemsmatris** visar en rad per säkert identifierad person, belagt
invalsår, personnamn, klubbnamn och födelseår samt ett färgkodat kryss per
matrikelutgåva. Tabellen har fasta identitetskolumner och en horisontellt
rullbar tidsaxel. Tom ruta betyder alltid »inte observerad«, inte utträde.

## Säkerhetskontrakt

- privata källkopior hashas före import;
- varje källrad får ett stabilt förekomst-ID;
- normalisering skriver aldrig över källtexten;
- rekonstruktioner har egna evidensfält och får aldrig visas som original;
- endast entydiga eller tidigare godkända identiteter kopplas automatiskt;
- osäkra träffar ligger kvar i granskningskön;
- ändringar sparas som nya operationer och synkas till `/klubbhistorik/ops`;
- publiceringspaketet innehåller endast det datafria appskalet.

## Privat master

- `privat/kallkopior/` — bytebevarade källkopior och godkända matchningsbeslut;
- `privat/kallkopior/matriklar/matrikel-ÅÅÅÅ.json` — samtliga
  matrikeldokument i samma validerade format; exakt en vald fil per kalenderår.
  Varianten med ålder eller födelsedatum som ledande fält prioriteras när den
  finns. Övriga årsvarianter ligger kvar som hashad källproveniens i årsfilen,
  men skapar inte egna matrikelutgåvor;
- `privat/kallkopior/matriklar/original/` — kanoniskt namngivna, bytebevarade
  privata kopior. Originalnamn och originalets SHA-256 ligger i varje JSON;
- `privat/kallkopior/matriklar-1991-1998.json` — sida-, kategori- och
  radspårbart äldre importunderlag, nu ersatt som konsumtionsformat av de
  synkade filerna ovan men bevarat för reproducerbarhet;
- `privat/migrering-2026-08-02/initial-ops.json` — reproducerbar startmaster;
- `privat/migrering-2026-08-02/kontrollrapport.json` — radtäckning,
  kontrollsummor, dubbletter och olösta identiteter;
- `privat/migrering-2026-08-02/kontrollrapport-1991-1998.json` — motsvarande
  för tilläggsutgåvorna;
- `privat/migrering-2026-08-02/kontrollrapport-synkade-matriklar.json` —
  radräkning och återanvändning för hela den gemensamma importen;
- `privat/migrering-2026-08-02/kontrollrapport-matrikel-2010.json` —
  radräkning, identitetsförslag och öppna kontrollpunkter för 2010;
- `privat/korrigeringar/` — efterhandsbeslut som nya, reproducerbara
  operationer ovanpå den låsta startmastern, inklusive importen av 1991 och
  1998, den normaliserade borttagningen av Ted Thunborgs extra 2025-rad,
  beslutet om en sorteringsvariant och den senare preciseringen till exakt en
  aktiv matrikel per kalenderår. 2010 ligger i en ny append-only-batch, följd
  av en ny årsvalsbatch och `2026-08-03-kalltrogen-layout-v3.json` med 1 606
  layoutrader, separerade flerspersonrader och strukturerade båtårsperioder.
  De tidigare Dropbox-distribuerade batcherna skrivs inte över.
  `2026-08-04-grundarmatrikel-1940-tal.json` lägger ovanpå samma master en
  källkorsläst arbetsrekonstruktion av tio grundare. Exakt år, bostadsö,
  platsdetalj och säkerhet lagras var för sig;
  Den gamla startmastern och de ordagranna källraderna byggs aldrig om i
  Dropbox;
- levande operationer — `/klubbhistorik/ops` i Korpholmens Dropbox App Folder.
- snabb privat startpunkt — `checkpoints/latest.json` pekar på en
  innehållsadresserad `snapshots/*.snapshot-v3.json.gz`; den byggs automatiskt
  efter seedning och innehåller materialiserat tillstånd, konfliktmetadata och
  vattenmärken, aldrig originalbilder eller PDF:er.

Båtreferenserna är privata snapshots av all strukturerad metadata i
Båtregistret utom bilder. De används för begripliga matchningsetiketter och
efterkontroll; Båtregistret förblir ensam master för själva båten.

## Kommandon

```sh
npm run build:sources
npm run build:migration
npm run validate:sources
npm test
npm run build:publish
npm run seed:dropbox -- "/Users/.../Dropbox/Appar/Korpholmen"
```

GitHub Pages får aldrig den privata datan. Seed-kommandot skriver
oföränderliga batcher till `/klubbhistorik/ops`, vägrar andra Dropbox-rötter,
skriver aldrig över en befintlig batch med annat innehåll och bygger därefter
en atomisk, komprimerad checkpoint från samtliga batcher i Dropbox-spegeln.
Den tidigare webbläsarbootstrapen från en hårdkodad lista av stora
korrigeringsfiler är avvecklad.
