# KBK Klubbhistorik

Appens avsedda lager, tidsaxlar, granskningsflöde och framtida utbyggnad finns
i [`ARKITEKTUR.md`](ARKITEKTUR.md). Ansvarsfördelningen mellan alla appar finns
i [`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

Lokal-först-app för Korpholmens Båtklubbs medlems- och båthistorik. Appen
bevarar varje källrad och håller den åtskild från tolkningen. Den länkar
godkända förekomster till Matrikelns stabila person-ID och Båtregistrets
stabila båt-ID, men skriver inte automatiskt tillbaka till dessa mastrar.

Pilotmastern omfattar matrikelutgåvorna 1980, 1986 och 2025. I 1980 och 1986
bevaras både medlems- och fartygskolumnen. Kolumnerna är självständiga i
källan; appen påstår därför inte att en båt på en viss rad ägdes av personen
på motsvarande rad.

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
- `privat/migrering-2026-08-02/initial-ops.json` — reproducerbar startmaster;
- `privat/migrering-2026-08-02/kontrollrapport.json` — radtäckning,
  kontrollsummor, dubbletter och olösta identiteter;
- levande operationer — `/klubbhistorik/ops` i Korpholmens Dropbox App Folder.

## Kommandon

```sh
npm run build:migration
npm test
npm run build:publish
npm run seed:dropbox -- "/Users/.../Dropbox/Appar/Korpholmen"
```

Startmastern kan endast aktiveras från källappen på localhost. GitHub Pages
får aldrig den privata datan. Seed-kommandot skriver oföränderliga batcher
till `/klubbhistorik/ops`, vägrar andra Dropbox-rötter och skriver aldrig över
en befintlig batch med annat innehåll.
