# Aktuellt läge

Senast kontrollerad: 2026-08-15.

| Master | Aktiv generation 2 | Skrivläge | Nästa steg |
|---|---:|---|---|
| Personer och familjer | revision 21 | Skrivskyddad | Används som stabil identitetsmaster; separat writer-byte planeras först när ett enkelt personformulär finns |
| Matrikel | revision 10 | Aktiv writer | Fortsatt normal användning och logikkontroll |
| Båtregister | revision 3 | Aktiv writer | Arbeta vidare och granska direkt i den vanliga V2-appen; generation 1 är fryst och bevarad som arkiv |
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
