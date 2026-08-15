# Aktuellt läge

Senast kontrollerad: 2026-08-15.

| Master | Aktiv generation 2 | Skrivläge | Nästa steg |
|---|---:|---|---|
| Personer och familjer | revision 21 | Skrivskyddad | Används som stabil identitetsmaster; separat writer-byte planeras först när ett enkelt personformulär finns |
| Matrikel | revision 10 | Aktiv writer | Fortsatt normal användning och logikkontroll |
| Båtregister | revision 4 | Aktiv writer | Arbeta vidare och granska direkt i den vanliga V2-appen; generation 1 är fryst och bevarad som arkiv |
| Fastigheter | revision 22 | Aktiv writer | Fortsatt normal användning och kontroll av ändringskvitton |
| Dokumentarkiv | revision 4 | Skrivskyddad | Fortsätt dokumentgranskning; writer-byte senare |
| Kartdata | revision 1 | Skrivskyddad | Normal läsning; writer-byte senare |
| Korpholmen runt | revision 4 | Skrivskyddad | Normal läsning; writer-byte senare |

Generation 1-data är fryst eller fortsatt ensam writer enligt tabellen ovan.
Inget writer-byte får ske bara genom att kod finns: privat fullbackup,
sent-delta-kontroll, återställningsprov och kontroll av korsapplänkar krävs
först.

Det stora migreringsarbetsmaterialet och tidigare projektutkast är flyttade
till det externa säkerhetskopiearkivet. Den aktiva Git-arbetsytan ska normalt
vara ren mot `main`; enda tillåtna avvikelsen är en tydligt namngiven pågående
arbetsgren.

## Aktuella webbadresser och katalognamn

- `personer-familjer/` är appen **Personer & familjer**.
- `matrikel/` är appen **Matrikel** för medlemskap, klubbnamn, invalsår och
  historiska matrikelutgåvor.
- `klubbhistorik/` innehåller endast en omdirigering till `matrikel/` så att
  äldre bokmärken inte går sönder.

De historiska Dropbox-namnrymderna `/matrikel/ops` för personmasterns
generation 1 och `/klubbhistorik/ops` för medlemsmasterns generation 1 är
frysta revisionsspår. De byts inte om eftersom ett sådant byte skulle bryta
återställning och äldre kontrollsummor; de exponeras inte som appnamn.

## Båtbilder

Båtmaster revision 4 återför de bildreferenser som utelämnades när revision 3
byggdes. Samtliga 260 refererade originalfiler har kontrollerats mot SHA-256.
Den aktiva mastern innehåller nu 140 bildposter för 122 båtar. Generation 1 är
orörd och en separat fullbackup finns från före korrigeringen.
