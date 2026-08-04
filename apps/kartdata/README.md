# Kartdata — strukturerad kartmaster

Kartdata v2 visar den aktiva kartdatan utan den äldre arbetsbokens
källpaneler, anteckningar eller AI-förslag. Appen har fyra vyer: översikt,
östruktur, granskningskö och en kompakt tabell.

Varje datapost innehåller namn, objektstyp, valfri undertyp och
granskningsstatus. Ö och fastighet är strukturerade länkar. Dagens ägare
visas enbart från Fastighetshistorikens granskade nulägesbedömning och
länkas vidare till Matrikeln när ägarparten är en person. Kartdata lagrar
varken ägare eller personnamn som egen masterdata.

Den konkreta modellen finns i [`DATAMODELL.md`](DATAMODELL.md). Appfamiljens
ansvarsgränser finns i [`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

## Bygg och kontrollera

```sh
npm run build:clean-v2
npm test
npm run build:publish
```

Den rena migrationen läser de tre levande Dropbox-mastrarna men skriver bara
privata förhandsfiler. Den publiceras inte till Dropbox förrän följande
kommando körs uttryckligen:

```sh
npm run seed:clean-v2
```

Dropbox-namnrymden är fortsatt `/kartdata/ops`. Det publika paketet i
`kartdata/` är datafritt.

Äldre ägarreferenser ligger kvar tekniskt som fallback. Den normala appen
läser `/fastigheter/ops` och `/matrikel/ops` skrivskyddat och sparar dem endast
som lokal cache.
