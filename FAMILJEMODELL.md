# Familjemodell för Korpholmens appar

Matrikeln och Båtregistret använder samma begrepp, men de beskriver olika
sorters tillhörighet. Modellen undviker att ett efternamn, en fastighet eller
en klubbgemenskap automatiskt behandlas som en belagd släktrelation.

## Fyra nivåer

1. **Nära familj** byggs automatiskt av registrerade personrelationer:
   föräldrar, syskon via gemensam förälder, partner, tidigare partner,
   medföräldrar och barn. Bara grundrelationerna lagras; syskon och
   medföräldrar visas som härledda samband.
2. **Familjegren** är den namngivna gren som personen brukar förknippas med,
   till exempel Böving eller Åkerman. Den hjälper orienteringen men är inte i
   sig bevis för en bestämd relation mellan varje person i grenen.
3. **Stamfamilj och släktkrets** ger den långa historiska orienteringen. En
   stamfamilj kan vara Carl Gunder och Bibbi inom den bredare
   Hedström-kretsen. Detta är presentationsmetadata och ska hållas skilt från
   personrelationerna.
4. **Fastighetsgemenskap** beskriver anknytning till samma plats. Den är en
   egen dimension: personer på samma fastighet behöver inte vara släkt, och
   släktingar på olika fastigheter visas inte som ett lokalt hushåll.

## Ansvar mellan apparna

- **Matrikeln** är master för personer, personrelationer, familjegrenar,
  släktkretsar, medlemskap, fastigheter och öar.
- **Båtregistret** är master för båtar, motorer, bilder och båtens historik.
  En båt kopplas helst till en bestämd person. En koppling till familjegren
  används bara när källan faktiskt gäller familjen som helhet eller när en
  person inte kan avgöras.
- Länkar mellan apparna använder stabila person-id:n. Visningsnamn är etikett,
  inte identitet.

## Käll- och säkerhetsregel

Familjevyer får härleda navigation, exempelvis syskon via en gemensam
förälder, men får aldrig skriva tillbaka en härledning som ny godkänd sakdata.
En osäker eller historisk hypotes ska ligga i ett särskilt forskningslager,
inte i apparnas master.
