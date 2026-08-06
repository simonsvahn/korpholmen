# Datamodell för Korpholmen runt

| Entitet | Ansvar |
|---|---|
| `race-source` | Källfil, kontrollsumma, tabell och importtid. |
| `race-edition` | Ett registrerat tävlingsår och dess sammanfattning. |
| `race-result` | En källrad/resultatpost med råvärden och normaliserade analysfält. |
| `race-person-link` | En tävlande och dess koppling till Matrikelns person-ID. Alla länkar har samma roll: `tävlande`. |
| `race-participant-placeholder` | Ett beslutat terminalt deltagarobjekt, exempelvis ”Med flera”, när ytterligare identiteter inte kan fastställas. |
| `person-ref` | Lokal referenskatalog över Matrikelns stabila personer. |
| `boat-ref` | Äldre lokal läskopia av Båtregistrets stabila båtar, endast reserv när den levande skrivskyddade mastern ännu inte har synkats. |
| `source-note` | Tomma rader, förklaringar och övrigt som inte är resultat. |

## Källtrohet

`boat_name_raw`, `class_raw` och `participants_raw` bevarar källans värden och
ändras aldrig tyst. `participants_raw` är en ordnad lista över de deltagarnamn
som källraden innehåller. Den innebär ingen uppdelning i kapten och besättning.
Access-radens ursprungliga kolumner finns dessutom oförändrade i `raw_row`.
En bekräftad felskrivning av båtnamn lagras separat som
`boat_name_corrected`, med status och beslutsnotering. Appens vanliga vyer och
sökning använder då det rättade namnet; rånamnet syns bara som uttrycklig
källproveniens. Normaliseringar är separata fält. `duration_seconds` sätts bara när tiden kan
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

Aktuella båtnamn och samtliga valbara båtar läses skrivskyddat från
Båtregistrets levande master. `boat-ref` används endast som lokal reserv innan
den första synkningen och får inte begränsa vilka nuvarande båtar som går att
välja.

En person- eller båtlänk har `match_status`:

- `kopplad` — entydig exakt träff på fullständigt namn eller båtalias;
- `föreslagen` — en eller flera kandidater, inklusive unikt förnamn, kräver beslut;
- `saknas` — ingen rimlig registerträff;
- `manuell` — användaren har valt stabilt ID i appen.

Ett unikt förnamn får ett kandidat-ID så att materialet kan utforskas, men
markeras alltid som obekräftat och ligger kvar i granskningskön. Sammansatta
eller oklara källfält bevaras som en enda råuppgift tills de delas genom en
granskningsoperation.

Alla `race-person-link` har rollen `tävlande`. `participant_order` styr endast
visningsordningen och `participant_group` anger vilket råvärde länken kommer
från, så att en sammansatt namnrad kan delas utan att källstrukturen går
förlorad. Fälten uttrycker aldrig kapten, besättning eller rang.

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
