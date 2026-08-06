# Korpholmen runt

Tävlingsappens ansvar och dess stabila länkar till Matrikel och Båtregister
finns i den gemensamma [`ARKITEKTUR.md`](../../ARKITEKTUR.md); entiteterna
finns i [`DATAMODELL.md`](DATAMODELL.md).

Lokal-först-master och analysapp för Korpholmen runt. Access-källans alla
resultatrader bevaras ordagrant i en privat, reproducerbar operationsmaster.
Normaliserade tider, klasser och bankoder ligger bredvid råvärdena och kan
kompletteras utan att ursprungsuppgiften skrivs över.

Appen länkar båtar till Båtregistrets stabila ID och deltagare till Matrikelns
person-ID. En post är kopplad först när ett stabilt ID har valts. Möjliga
träffar visas bara som förslag; de räknas inte som länkar och kan avgöras
manuellt eller i bulk.
Alla personer i ett resultat har samma roll, **tävlande**. Källans eventuella
kolumnindelning används inte som kapten-/besättningsdata; originalraden finns
fortfarande kvar för källkontroll.
Det aktuella personnamnet läses skrivskyddat från Matrikel. Resultatets rånamn
ligger kvar i tävlingsmastern och ändras inte när personen byter namn.
På samma sätt läses hela den aktuella båtkatalogen skrivskyddat från
Båtregister. Äldre `boat-ref`-poster är bara en offline-reserv och begränsar
inte matchningslistan. En bekräftad felskrivning i tävlingskällan visas med det
rättade båtnamnet medan originalvärdet bevaras som uttrycklig proveniens.

Alla resultat visas alltid. De filtreras aldrig bort från resultatlistor,
placeringar, topptider eller rekord på grund av gransknings- eller
kopplingsläge. Varje resultatrad kan justeras direkt: klass, tid, båt och
valfritt antal tävlande. Källans råvärden bevaras även när den normaliserade
posten ändras.

På sidan **År för år** kan det handskrivna originalet fällas ut under
**Källmaterial**. Appen hämtar en icke-generativ JPEG-läskopia från den privata
Dropbox-mastern och kontrollerar dess SHA-256 innan den visas. Bilden och dess
metadata ingår aldrig i det datafria GitHub Pages-paketet.

Den beslutade klassstandarden kan tillämpas på hela den levande mastern med
ett knapptryck. Åtgärden fyller stabilt klass-ID och standardnamn, men lämnar
`class_raw` orört så att varje normalisering går att kontrollera mot källan.

Källuppgiften ”med flera” representeras som en strukturerad, terminal
platshållare. Den betyder okända ytterligare tävlande och ska därför varken
skapa en påhittad person eller ligga kvar som en fråga som aldrig kan avslutas.

## Privat master

- `privat/kallkopior/Korpholmen runt konv.mdb` — bytebevarad källkopia.
- `privat/migrering-2026-08-02/initial-ops.json` — kanonisk startmaster.
- `privat/migrering-2026-08-02/korpholmenrunt.sqlite` — relationell läs- och
  analyskopia av samma startläge.
- Levande operationer synkas till `/korpholmenrunt/ops` i Korpholmens
  gemensamma Dropbox App Folder.

## Kommandon

```sh
npm run build:migration
npm run migrate:tavlande -- --dry-run
npm run migrate:med-flera
npm test
npm run build:publish
node verktyg/bygg-kallbilder.mjs "/Users/.../Dropbox/Appar/Korpholmen" "/Users/.../Digitalisering 2026/01 Digitaliserade dokument"
node verktyg/granska-batkopplingar.mjs "/Users/.../Dropbox/Appar/Korpholmen"
node verktyg/standardisera-klasser.mjs "/Users/.../Dropbox/Appar/Korpholmen"
node verktyg/ratta-homsan-till-mymlan.mjs "/Users/.../Dropbox/Appar/Korpholmen" --write
```

På localhost kan den privata startmastern aktiveras i en tom lokal databas och
därefter laddas upp till Dropbox. V3-startmastern använder egna, versionerade
device-id:n så att en ombyggnad aldrig återanvänder en publicerad
operationsidentitet. Publiceringspaketet är datafritt och byggs till
repo-rotens `korpholmenrunt/` för GitHub Pages.
Klassmigreringen läser den materialiserade levande operationsströmmen och
skriver endast nya, oföränderliga batcher. Den kan köras om utan att skapa
dubbletter eller skriva över tidigare operationer.
