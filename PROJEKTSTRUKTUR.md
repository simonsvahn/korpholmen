# Projektstruktur

Projektmappen ska visa den senaste fungerande versionen. Historiska
leveranser, engångsexporter och avslutade migreringsfaser hör till det externa
Korpholmen-arkivet, inte till den aktiva arbetsytan.

## Det som hör hemma här

| Sökväg | Innehåll |
|---|---|
| `apps/<app>/` | Källkod, appens tester och återanvändbara byggverktyg |
| `apps/<app>/privat/` | Lokal privat arbetsdata; alltid Git-ignorerad |
| `packages/` | Gemensam datafri kod och lokala granskningsverktyg som fortfarande används |
| `<app>/` i roten | Byggd, datafri webbversion för GitHub Pages |
| `verktyg/` | Gemensamma återanvändbara bygg-, publicerings- och migreringsverktyg |
| `README.md`, `ARKITEKTUR.md`, `FAMILJEMODELL.md`, `STATUS.md` | Den aktuella dokumentationen |

`apps/fastigheter/` är alltså källan som utvecklas. `fastigheter/` är den
byggda publika leveransen. Samma princip gäller övriga appar.

## Det som inte hör hemma på GitHub

- privata masterfiler, bilder, källkopior och granskningsbeslut;
- backupkopior och frysta generation 1-operationer;
- avslutade fasleveranser och engångsexporter;
- tillfälliga renderingsfiler, kalkylbladsinspektioner och `node_modules`.

Det fullständiga arbetsmaterialet från migreringen 2026-08-07 ligger i det
externa säkerhetskopiearkivet. Den aktiva projektmappen innehåller ingen kopia
eller genväg till arkivet. Äldre kontroll- och återställningsmaterial öppnas
direkt från arkivet när det verkligen behövs.

## Git-regel

`main` är den enda långlivade GitHub-grenen. En pågående förändring får ha en
kortlivad `codex/...`-gren och en pull request. När den är sammanslagen och
kontrollerad tas arbetsgrenen bort. Privat data får aldrig läggas till ens på
en tillfällig gren.
