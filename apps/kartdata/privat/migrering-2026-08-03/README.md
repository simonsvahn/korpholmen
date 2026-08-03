# Byggd startmaster

Denna mapp skapas av `npm run build:migration`. JSON- och rapportfilerna är
privata och ignoreras av Git; denna README dokumenterar endast flödet.

- `initial-ops.json` bevarar arbetsbokens 161 källrader och den första
  platsstrukturen med oförändrade operations-ID:n.
- `structure-ops.json` är strukturdelmängden för lokal efterstart.
- `place-names-ops.json` är en separat additiv migration för historiska och
  alternativa namn. Den kan appliceras på befintliga databaser utan att den
  första migrationens identiteter ändras.
- `manifest.json` och `importkontroll.md` redovisar sammanlagda antal och
  kontrollerade SHA-256-värden.
