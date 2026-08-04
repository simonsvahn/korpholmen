# Core

Kärnans plats som datafri teknik, utan eget sakansvar, finns i
[`../../ARKITEKTUR.md`](../../ARKITEKTUR.md).

Datafri, generell lokal-först-motor som delas av Korpholmens appar. Varje app
använder egen IndexedDB-databas och egen Dropbox-operationsmapp. Matrikeln
använder `/matrikel/ops`; Båtregister använder `/batregister/ops`.

IndexedDB-lagret innehåller operationer, metadata, snapshots och ett separat
bloblager för privat mediacache och väntande uppladdningar. Appskalet hanteras
separat av respektive apps service worker.

`ReadOnlyMaster` läser en annan apps Dropbox-namnrymd utan uppladdningsrätt och
sparar dess materialiserade läge som lokal snapshot. Främmande operationer
läggs aldrig i den läsande appens op-logg. `master-data.js` gör ID-baserade
joins för personer, fastigheter och aktuella ägare; namnlikhet används inte.
