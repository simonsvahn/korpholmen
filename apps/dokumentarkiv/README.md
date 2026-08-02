# Dokumentarkiv

Dokumentarkivets roll som ordagrann källmaster, inte entitetsmaster, finns i
den gemensamma [`ARKITEKTUR.md`](../../ARKITEKTUR.md).

Dokumentarkivet visar fullständiga, ordagranna avskrifter från
`Digitalisering 2026` i ett läsbart dokumentformat. Handlingarna går att söka
och filtrera efter kategori och strukturerad entitet, exempelvis person, båt,
plats, fastighet, hus eller organisation.

Startsidan är en arkivatlas med lika breda decennier, årsmatris och
täckningskarta. Därifrån kan samma privata dokumentdata utforskas som
berättelsespår, källbundna samband, schematisk platskarta, arbetskö och
frågesökning med textutdrag. Avskriftsuppdateringar bevaras som nya operationer
och kan jämföras utan att original eller tidigare läsningar skrivs över.

Appskalet är datafritt och kan publiceras på GitHub Pages. Avskrifter och
registerkopplingar lagras som immutabla operationer i den gemensamma privata
Dropbox App Foldern under `/dokumentarkiv/ops` och materialiseras lokalt i
IndexedDB. Exakta registerträffar pekar på stabila ID:n i Matrikeln eller
Båtregistret. Osäkra och saknade träffar markeras uttryckligen.

## Kommandon

- `npm run build:migration` bygger `privat/aktuell-startmaster` från samtliga
  publicerbara avskrifter och inventerar samtidigt inkorgens kvarvarande filer.
- `npm test` kontrollerar data, kopplingar och det datafria appskalet.
- `npm run build:publish` bygger publiceringspaketet i `/dokumentarkiv`.
- `npm run seed:dropbox -- "/Users/.../Dropbox/Appar/Korpholmen"` skriver
  startmastern till Dropbox utan att skriva över en befintlig, avvikande batch.

Källbilder, beskurna läskopior och avskriftsfiler ligger kvar orörda i
`Digitalisering 2026`. Dokumentarkivet läser bara Markdown-avskrifterna när en
ny privat startmaster byggs.

Varje ny Dropbox-release ska få en unik `KORPHOLMEN_MIGRATION_TAG` och en senare
`KORPHOLMEN_MIGRATION_CLOCK`. Operationsbatcherna i Dropbox är immutabla;
`aktuell-startmaster` är endast den lokala pekaren till senaste genererade
release.
