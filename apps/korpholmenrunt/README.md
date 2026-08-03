# Korpholmen runt

Tävlingsappens ansvar och dess stabila länkar till Matrikel och Båtregister
finns i den gemensamma [`ARKITEKTUR.md`](../../ARKITEKTUR.md); entiteterna
finns i [`DATAMODELL.md`](DATAMODELL.md).

Lokal-först-master och analysapp för Korpholmen runt. Access-källans alla
resultatrader bevaras ordagrant i en privat, reproducerbar operationsmaster.
Normaliserade tider, klasser och bankoder ligger bredvid råvärdena och kan
kompletteras utan att ursprungsuppgiften skrivs över.

Appen länkar båtar till Båtregistrets stabila ID och deltagare till Matrikelns
person-ID. Endast entydiga träffar kopplas automatiskt. Möjliga och olösta
träffar visas i appens granskningskö och kan avgöras manuellt.

Ofullständigt granskade analoga år kan publiceras som preliminära rader. De
visas tydligt i resultatlistan och under **Granska & matcha**, där varje rad kan
öppnas, rättas och godkännas. Preliminära eller tidsosäkra rader räknas inte i
placeringar, topptider eller rekord förrän de har godkänts. Källans råvärden och
granskningsfrågor bevaras även när den normaliserade posten ändras.

## Privat master

- `privat/kallkopior/Korpholmen runt konv.mdb` — bytebevarad källkopia.
- `privat/migrering-2026-08-02/initial-ops.json` — kanonisk startmaster.
- `privat/migrering-2026-08-02/korpholmenrunt.sqlite` — relationell läs- och
  analyskopia av samma startläge.
- Levande operationer synkas till `/korpholmenrunt/ops` i Korpholmens
  gemensamma Dropbox App Folder.

## Kommandon

```sh
npm run build:migration
npm test
npm run build:publish
```

På localhost kan den privata startmastern aktiveras och därefter laddas upp
till Dropbox. Publiceringspaketet är datafritt och byggs till
repo-rotens `korpholmenrunt/` för GitHub Pages.
