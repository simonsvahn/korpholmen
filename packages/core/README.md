# Core

Datafri, generell lokal-först-motor som delas av Korpholmens appar. Varje app
använder egen IndexedDB-databas och egen Dropbox-operationsmapp. Matrikeln
använder `/matrikel/ops`; Båtregister använder `/batregister/ops`.

IndexedDB-lagret innehåller operationer, metadata, snapshots och ett separat
bloblager för privat mediacache och väntande uppladdningar. Appskalet hanteras
separat av respektive apps service worker.
