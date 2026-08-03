# Kartdata — källgranskning och platsregister

Kartdata visar de 161 raderna i arbetsboken *Kartans namn per fastighet
(radgranskning 2026-07-22)* som källuppgifter, inte som redan godkänd
masterdata. Appen grupperar visuellt efter ö/område och föreslagen
fastighetskoppling, har en prioriterad granskningskö och en särskild
Östruktur-vy för stabila plats- och byggnadsobjekt.

Tabellvyn är en filtrerbar datagrid med fasta namnkolumner, typ- och
statusmarkörer, expanderbara detaljrader och redigering per rad. Samtliga elva
källfält och hela granskningslagret är åtkomliga utan att presenteras som ett
brett kalkylblad.

## Säkerhetsprincip

- Arbetsboken ändras aldrig.
- Alla elva källkolumner bevaras i `source_*`/`prior_*`.
- Bekräftelser och rättelser sparas i `review_*` som återställningsbara
  operationer.
- Ogranskade kartposter får inte automatiskt bli plats-, byggnads- eller fastighetsmaster.
- Plats- och byggnadsobjekt har stabila ID:n; namn och relationer är separata, källspårbara poster.
- Dropbox-namnrymden är `/kartdata/ops`, separat från
  Fastighetshistorikens `/fastigheter/ops`.
- Det publika paketet är datafritt; bara appskalet publiceras.

Den konkreta modellen finns i [`DATAMODELL.md`](DATAMODELL.md). Appfamiljens
ansvarsgränser finns i [`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

## Lokal start och bygg

Källkopian ligger lokalt under `privat/kallkopior/` och byggs till en
oföränderlig startoperationsfil:

```sh
npm run build:migration
npm test
npm run build:publish
npm run seed:dropbox -- "/Users/simon/Dropbox/Appar/Korpholmen"
```

När källappen öppnas från `/apps/kartdata/` läses startkopian automatiskt om
det lokala lagret är tomt. En granskning kan också exporteras som JSON.

Historiska och alternativa platsnamn byggs som en separat, additiv migration.
Den kan därför läggas till i en redan använd databas utan att äldre
operations-ID:n eller manuella rättelser skrivs över. Dropbox-skriptet skriver
endast nya immutabla batchfiler och avbryter om en befintlig fil skiljer sig.
