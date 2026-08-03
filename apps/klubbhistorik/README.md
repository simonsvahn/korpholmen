# KBK Klubbhistorik

Appens avsedda lager, tidsaxlar, granskningsflöde och framtida utbyggnad finns
i [`ARKITEKTUR.md`](ARKITEKTUR.md). Ansvarsfördelningen mellan alla appar finns
i [`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

Lokal-först-app för Korpholmens Båtklubbs medlems- och båthistorik. Appen
bevarar varje källrad och håller den åtskild från tolkningen. Den länkar
godkända förekomster till Matrikelns stabila person-ID och Båtregistrets
stabila båt-ID, men skriver inte automatiskt tillbaka till dessa mastrar.

Mastern omfattar 23 källsnapshots från juli 1980 till augusti 2025. I de
historiska matriklarna bevaras medlems- och fartygskolumnen var för sig,
inklusive passiva, juniorer, korresponderande och avregistrerade/namnändrade
fartyg där källan har sådana avsnitt. Kolumnerna är självständiga i källan;
appen påstår därför inte att en båt på en viss rad ägdes av personen på
motsvarande rad.

Vyn **Medlemsmatris** visar en rad per säkert identifierad person, belagt
invalsår, personnamn, klubbnamn och födelseår samt ett färgkodat kryss per
matrikelutgåva. Tabellen har fasta identitetskolumner och en horisontellt
rullbar tidsaxel. Tom ruta betyder alltid »inte observerad«, inte utträde.

## Säkerhetskontrakt

- privata källkopior hashas före import;
- varje källrad får ett stabilt förekomst-ID;
- normalisering skriver aldrig över källtexten;
- endast entydiga eller tidigare godkända identiteter kopplas automatiskt;
- osäkra träffar ligger kvar i granskningskön;
- ändringar sparas som nya operationer och synkas till `/klubbhistorik/ops`;
- publiceringspaketet innehåller endast det datafria appskalet.

## Privat master

- `privat/kallkopior/` — bytebevarade källkopior och godkända matchningsbeslut;
- `privat/kallkopior/matriklar/*.json` — samtliga matrikeldokument i samma
  validerade format; en fil per faktisk käll-/sorteringsvariant;
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
- `privat/korrigeringar/` — efterhandsbeslut som nya, reproducerbara
  operationer ovanpå den låsta startmastern, inklusive importen av 1991 och
  1998 samt den normaliserade borttagningen av Ted Thunborgs extra 2025-rad.
  Den gamla startmastern och de ordagranna källraderna byggs aldrig om i
  Dropbox;
- levande operationer — `/klubbhistorik/ops` i Korpholmens Dropbox App Folder.

Båtreferenserna är privata snapshots av all strukturerad metadata i
Båtregistret utom bilder. De används för begripliga matchningsetiketter och
efterkontroll; Båtregistret förblir ensam master för själva båten.

## Kommandon

```sh
npm run build:migration
npm run validate:sources
npm test
npm run build:publish
npm run seed:dropbox -- "/Users/.../Dropbox/Appar/Korpholmen"
```

Startmastern kan endast aktiveras från källappen på localhost. GitHub Pages
får aldrig den privata datan. Seed-kommandot skriver oföränderliga batcher
till `/klubbhistorik/ops`, vägrar andra Dropbox-rötter och skriver aldrig över
en befintlig batch med annat innehåll.
