# Datamodell för fastighetshistorik

| Entitet | Ansvar |
|---|---|
| `property` | Dagens stabila fastighetsidentitet. |
| `historical-unit` | Äldre skifteslott/jordenhet som inte ska låtsas vara dagens beteckning. |
| `property-relation` | Föregångare, avstyckning eller annan kadastral relation. |
| `party` | Person, organisation, dödsbo eller ännu oupplöst namngrupp. Kan länka till ett stabilt person-ID i Matrikeln. |
| `holding` | En parts roll på en fastighet eller historisk enhet, med datum/intervall och belägg. |
| `holding-claim` | Strukturerat men ännu inte likvärdigt belagt innehav, boende, hyra, dödsbo eller verksamhetsroll från råkedjan. |
| `event` | Överlåtelse, arv, auktion, avstyckning, lagfart eller annan daterad händelse. |
| `event-claim` | Strukturerad förrättnings-, pris- eller övergångsuppgift med intervall, säkerhet och verifieringsstatus. |
| `event-party` | Köpare, säljare, sökande eller annan roll i en händelse. |
| `observation` | Samlat registerögonblick med `observed_on`; anger inte automatiskt förvärvsdatum. |
| `source` + `evidence` | Källan och dess stöd för ett specifikt objekt. |
| `audit-finding` | Källkontrollen av den äldre manuella ägartabellen. |
| `community-link` | Personanknytning från Matrikeln; alltid `legal_ownership: false`. |
| `manual-claim` | Ordagrann råuppgift med obligatorisk pekare till sin normaliserade `holding-claim` eller `event-claim`. |

## Datum

Ett enda `year`-fält räcker inte. En affär kan ha olika datum för avtal,
tillträde, ansökan, förrättning och fastställelse. Registerskärmdumpar får bara
`observed_on`. När datumet är osäkert bevaras källans formulering i ett
`*_date_text`-fält i stället för att agenten hittar på en precis dag.

## Forskningsregel

Härledningar får göras i frågor och visualiseringar men får inte skrivas som
nya fakta utan evidens. Två motstridiga pris-, datum- eller ägaruppgifter ska
ligga kvar som två anspråk tills de kan avgöras.

Roll är ett eget forskningsfält. `hyresgäst`, `boende/brukare`,
`pensionatsinnehavare/verksamhetsutövare`, `dödsbo` och `lagfaren ägare` får
inte reduceras till samma ägarstatus. Ett källbelägg kan dessutom stödja bara
en viss roll eller ett visst datumfält; det behöver inte bevisa hela posten.
