# Dokumentarkiv

Dokumentarkivet visar fullständiga, ordagranna avskrifter från
`Digitalisering 2026` i ett läsbart dokumentformat. Handlingarna går att söka
och filtrera efter kategori och strukturerad entitet, exempelvis person, båt,
plats, fastighet, hus eller organisation.

Appskalet är datafritt och kan publiceras på GitHub Pages. Avskrifter och
registerkopplingar lagras som immutabla operationer i den gemensamma privata
Dropbox App Foldern under `/dokumentarkiv/ops` och materialiseras lokalt i
IndexedDB. Exakta registerträffar pekar på stabila ID:n i Matrikeln eller
Båtregistret. Osäkra och saknade träffar markeras uttryckligen.

## Kommandon

- `npm run build:migration` bygger den privata startmastern från avskrifterna.
- `npm test` kontrollerar data, kopplingar och det datafria appskalet.
- `npm run build:publish` bygger publiceringspaketet i `/dokumentarkiv`.
- `npm run seed:dropbox -- "/Users/.../Dropbox/Appar/Korpholmen"` skriver
  startmastern till Dropbox utan att skriva över en befintlig, avvikande batch.

Källbilder, beskurna läskopior och avskriftsfiler ligger kvar orörda i
`Digitalisering 2026`. Dokumentarkivet läser bara Markdown-avskrifterna när en
ny privat startmaster byggs.
