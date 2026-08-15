# Master data v2

Första datafria fas 3-kärnan för den beslutade generation 2-modellen.

Paketet innehåller:

- komplett, validerad `master.json` med vanlig domändata;
- ett gemensamt schema för mastermetadata, `needs_review`, stabila referenser
  och strukturerad tid;
- strukturerade båtkategorier och tidslinjehändelser där registrering, köp,
  försäljning och ägande bär stabila person- eller `family_unit`-referenser;
- strukturerade namnbyten med tidigare namn, nytt namn och tid;
- ett personkontrakt där extern/historisk kontext kan sparas som en enkel
  `context_note`, medan medlemskap och sakroller ligger i sina ägarappar;
- en atomisk sparomgång per `change_id`, även för stora batcher;
- optimistisk revisionskontroll som avvisar en gammal telefon-/datorversion;
- idempotent återförsök och hållbar-kö-kontrakt;
- separat ändringskvitto som inte behövs vid appstart;
- papperskorg och återställning utan blind ”senaste vinner”.

`MemoryMasterStorage` är en testadapter. Den skriver ingen privat data. En
IndexedDB-/Dropboxadapter byggs separat efter att kontraktet är godkänt och ska
implementera samma compare-and-swap-regel. Framtida externt API ska kunna
implementera samma gränssnitt.

Kör:

```sh
npm test
```
