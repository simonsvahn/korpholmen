# Personer & familjer — V2

Appen är en skrivskyddad V2-läsare för den aktiva Personmastern. Personer är
standardvyn. Den gemensamma undermenyn innehåller **Släkter · Familjer ·
Personer**. Släkter ritar sammanhängande flergenerationsträd och Familjer visar
stabila familje-ID:n. Båda räknas från faktiska partner- och
förälder–barn-relationer.

Personakten visar livsuppgifter, medlemsnivå, namnformer, direkta relationer
och länkar via stabila ID:n till Matrikel, Båtregister, Fastigheter,
Dokumentarkiv och Korpholmen runt. Sakuppgifter redigeras i respektive ägarapp.
Gamla släktkretsar och kopierade fastighets- eller medlemsuppgifter används
inte som masterdata. Personpanelen visar bara den närmaste familjen i ett
kompakt format; det fulla sammanhanget visas i Släkter.

Personmasterns roll som identitetsmaster och dess gränser mot övriga appar finns i
den gemensamma [`ARKITEKTUR.md`](../../ARKITEKTUR.md). Familje- och
släktmodellen fördjupas i [`FAMILJEMODELL.md`](../../FAMILJEMODELL.md).

Ny lokal-först-app enligt samma arkitektur som Packa:

- datafritt appskal för GitHub Pages;
- privat data i IndexedDB och en separat Dropbox App Folder;
- oföränderliga operationer med HLC och fältvis LWW-merge;
- uttryckliga tombstones för borttagningar;
- inga helfilsöverskrivningar och ingen automatisk sammanslagning av äldre
  Chrome-/Safari-exporter;
- Service Worker cachar enbart appskalet.

## Datastatus

Aktiv V2 är revision 21 med 313 personer, 304 relationer och 62 stabila
familjeenheter. Appen kan läsa lokalt cachad data, men den aktiva Personmastern
är fortsatt skrivskyddad. Person- och relationsredigering kräver ett separat
writer-byte med backup, sent-delta-kontroll och återställningsprov.

## Bevarad generation 1

Den godkända startmastern ligger i `privat/migrering-2026-08-01/` som ett
privat arkiv, ett operationsdokument och 21 oföränderliga batcher. Den gamla
HTML-byggkedjan pensionerades efter att migreringen och dess kontrollsummor
verifierats; källans SHA-256 finns kvar i migreringsmanifestet.

Migreringen 2026-08-01 innehåller:

- 214 personer;
- 231 relationer;
- 5 061 fältoperationer i 21 oföränderliga batcher.

Den levande Dropbox-mastern har därefter utökats genom separata, oföränderliga
batcher. Den 2026-08-02 omfattar den 214 personer, 233 personrelationer, 49
FAMILJ och 25 SLÄKT. Korrigeringar byggs med
`verktyg/skapa-korrigeringsbatch.mjs` mot en privat, förhandsgranskad plan.
Verktyget kontrollerar förväntat startläge och slutläge innan en ny batch får
skapas; äldre batcher ändras aldrig. Planformatet kan även göra en uttrycklig
tombstone-radering med `"delete": true` och verifiera resultatet med
`verify_deleted`.

Identitetsrättelsen 2026-08-03 finns som privat plan och genererad batch under
`privat/korrigeringar/`. Den skapar `peterneretnieks`, tar bort de två
felaktiga föräldrabanden till `peterholm`, registrerar Anna Neretnieks som
Anna Holms födelsenamn och lämnar det äldre felläget kvar som återkallad
operationshistorik. Efter att batchen distribuerats är omfattningen 215
personer och 235 personrelationer.

De separata äldre Chrome- och Safari-exporterna slogs inte ihop. Deras
kontrollsummor och den uttryckliga behandlingen `arkiverad-men-inte-sammanslagen`
finns kvar i manifestet, så en äldre uppgift eller tidigare borttagen relation
kan inte återinföras av misstag.

`privat/` och `publicering/` är ignorerade. `npm run build:publish` använder en
strikt tillåtelselista och stoppar bygget om ett personnamn eller inbyggd
datamängd finns i det publika paketet.

## Lokal kontroll

Från denna mapp:

```sh
npm test
python3 -m http.server 8766
```

Öppna `http://localhost:8766/`. Knappen **Aktivera godkänd startkopia** finns
bara på localhost och läser den privata migreringen. Efter den kommande
Dropbox-aktiveringen laddar första enheten upp dessa batcher en gång; övriga
enheter hämtar dem genom vanlig synk.

## Dropbox och publicering

Den separata Dropbox-appen är skapad och dess publika appnyckel ligger i
`src/config.js`. Den ska vara en Scoped App med App Folder och behörigheterna
`files.metadata.read`, `files.content.read` och `files.content.write`.
App-hemlighet läggs aldrig i klienten. OAuth kör code flow med PKCE/S256.
Generation 1:s oföränderliga personbatcher ligger av historiska skäl i
`/matrikel/ops`, parallellt med
Båtregistrets `/batregister/ops`.

Det datafria paketet byggs till repo-rotens `personer-familjer/` med:

```sh
npm run build:publish
```

Appen publiceras på `https://simonsvahn.github.io/korpholmen/personer-familjer/`.
Repo-roten `https://simonsvahn.github.io/korpholmen/` är registrerad som
**Redirect URI** i Dropbox App Console och skickar OAuth-returen vidare till
rätt Korpholmen-app.

## Fastighetskopplingar

Fastighet och ö är inte ett fritextfält på personen. Matrikeln har ett
bekräftat navigationslager:

1. `property` med stabil fastighetsidentitet;
2. `property-link` som beskriver fastighetsgemenskap;
3. personens öanknytning kan presenteras från dessa kopplingar.

Sedan 2026-08-02 är appen **Fastighetshistorik** kanonisk master för själva
fastigheterna, historiska jordenheter, ägande, bruk och transaktioner.
Personmasterns fastighetslager är en övergångs-/navigationskopia. En
`property-link` är aldrig i sig bevis för juridiskt ägande.

Det äldre personfältet `legacy_island` bevaras under övergången så att ingen
befintlig öanknytning tappas innan fastighetskopplingarna har bekräftats.
