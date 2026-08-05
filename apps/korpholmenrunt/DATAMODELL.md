# Datamodell för Korpholmen runt

| Entitet | Ansvar |
|---|---|
| `race-source` | Källfil, kontrollsumma, tabell och importtid. |
| `race-edition` | Ett registrerat tävlingsår och dess sammanfattning. |
| `race-result` | En källrad/resultatpost med råvärden och normaliserade analysfält. |
| `race-person-link` | En deltagarroll och dess koppling till Matrikelns person-ID. |
| `race-participant-placeholder` | Ett beslutat terminalt deltagarobjekt, exempelvis ”Med flera”, när ytterligare identiteter inte kan fastställas. |
| `person-ref` | Lokal referenskatalog över Matrikelns stabila personer. |
| `boat-ref` | Lokal referenskatalog över Båtregistrets stabila båtar. |
| `source-note` | Tomma rader, förklaringar och övrigt som inte är resultat. |

## Källtrohet

`*_raw` är ordagranna värden från Access-tabellen och ändras aldrig tyst.
Normaliseringar är separata fält. `duration_seconds` sätts bara när tiden kan
tolkas som minuter och sekunder med sekunddelen 00–59. Värden som `35,67`,
`60+` och `80,95` bevaras men flaggas för granskning.
Appinmatning använder formatet minuter och sekunder, exempelvis `21:05`.
Tvetydiga tretalstider som `21:05:30` bevaras som råvärde men godtas inte som
normaliserad tid utan ett uttryckligt mänskligt beslut.

Klassen lagras i fyra separata fält: oförändrat `class_raw`, stabilt
`class_id`, visningsnamnet `class_name` samt beslutets
`class_match_status`/`class_match_method`. Klassstandarden har elva grenar:
Kanadensare, Kajak 1, Kajak 2, Rodd, Segel, Optimist, Gummi, Övrigt,
Okänd, Örnjolle och Rodd + segel. `Övrigt` används för en känd typ som inte
hör till en ordinarie gren; `Okänd` betyder att klassen saknas eller inte går
att avgöra. Källvärdena `Paddel`, `rodel`, `Dagen` och `jolle` normaliseras
till Kajak 2, Rodd, Rodd respektive Segel utan att råvärdet ändras.

## Registerkopplingar

En person- eller båtlänk har `match_status`:

- `kopplad` — entydig exakt träff på fullständigt namn eller båtalias;
- `föreslagen` — en eller flera kandidater, inklusive unikt förnamn, kräver beslut;
- `saknas` — ingen rimlig registerträff;
- `manuell` — användaren har valt stabilt ID i appen.

Ett unikt förnamn får ett kandidat-ID så att materialet kan utforskas, men
markeras alltid som obekräftat och ligger kvar i granskningskön. Sammansatta
eller oklara källfält bevaras som en enda råuppgift tills de delas genom en
granskningsoperation.

Källformen `m fl` eller `med flera` blir ett separat
`race-participant-placeholder`. Platshållaren är ett avslutat beslut om okända
ytterligare tävlande, inte en person och inte en öppen identitetsfråga. En
vanlig redigering av resultatet får inte demotera den tillbaka till
granskningskön.

## Masterprincip

Den kanoniska levande mastern är den materialiserade operationsströmmen i
appen/Dropbox. SQLite-filen är en reproducerbar analyskopia, inte en parallell
sanning. Nya uppgifter läggs som oföränderliga operationer; källimporten byggs
om bara när en ny källversion uttryckligen har lagts till.
