import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument, matrikelOpsArgument, pilotArgument = 'batmaster-pilot-agarmigrering-20260806-a'] = process.argv.slice(2);
if (!boatOpsArgument || !matrikelOpsArgument) {
  throw new Error('Användning: node bygg-agargranskningsunderlag.mjs BATREGISTER-OPS MATRIKEL-OPS [PILOT-ID]');
}

const boatOpsRoot = resolve(boatOpsArgument);
const matrikelOpsRoot = resolve(matrikelOpsArgument);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(appRoot, 'privat/piloter', pilotArgument);

async function jsonFiles(root) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(child);
    }
  }
  await visit(root);
  return output.sort();
}

async function loadMaster(root) {
  const batches = await Promise.all((await jsonFiles(root)).map(async path => {
    const batch = JSON.parse(await readFile(path, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  return materialize(batches.flatMap(batch => batch.ops));
}

const boatState = await loadMaster(boatOpsRoot);
const matrikelState = await loadMaster(matrikelOpsRoot);
const boats = boatState.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const ownerships = boatState.listEntities('boat-ownership-observation').map(entity => ({ entity_id: entity.entity_id, record: entity.fields.record }));
const personLinks = boatState.listEntities('boat-person-link').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const familyLinks = boatState.listEntities('boat-family-link').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const sources = new Map(boatState.listEntities('boat-source').map(entity => [entity.entity_id, entity.fields.record]));
const legacyAudits = new Map([
  ['lillakräket', 'Ett registerkort på samma sida som Gösta Jansson anger uttryckligen: ”Ägare bytt till MARTIN ÅKERMAN (1996)”. Registrera Petter och Martin som två ägarposter.'],
  ['höstsol', 'Avregistreringen 2009 säger att Höstsol varit i Britt-Maries krets ägo i 6–7 år och därefter lämnat till Oskarshamns skärgård. Kontrollera kedjan mot den äldre uppgiften och 2008 års överlåtandehandling.'],
]);

function linksForBoat(boatId) {
  return {
    person_links: personLinks.filter(link => link.boat_id === boatId).map(link => ({
      person_id: link.person_id,
      stored_name: link.person_display_name,
      role: link.role,
      confidence: link.confidence,
      mapping_source: link.source,
      person_exists_in_matrikel: Boolean(matrikelState.getEntity('person', link.person_id)),
    })),
    family_links: familyLinks.filter(link => link.boat_id === boatId).map(link => ({
      legacy_family_id: link.family_id,
      legacy_family_name: link.family_name,
      role: link.role,
      confidence: link.confidence,
      mapping_source: link.source,
    })),
  };
}

function classification(row) {
  const text = row.owner_text || '';
  if (!row.person_links.length && !row.family_links.length) return 'saknar_kopplingskandidat';
  if (/\?|trolig|osäker|m\.fl\.|resp\./i.test(text)) return 'osäker_eller_ofullständig';
  if (text.includes('→')) return 'ägarkedja_kräver_tidstolkning';
  if (row.family_links.length) return 'äldre_familjekoppling_att_mappa';
  if (row.person_links.length > 1) return 'flera_personer_att_granska';
  if (row.person_links.every(link => link.confidence === 'godkänd')) return 'tidigare_godkänd_identitet_källkontroll_krävs';
  return 'maskinmatchad_identitet_källkontroll_krävs';
}

function sourceLabelsForOwnership(records) {
  const ids = [...new Set(records.flatMap(item => item.record?.source_ids || []))];
  return ids.map(id => sources.get(id)?.label || id);
}

function ownerText(records) {
  return records
    .sort((left, right) => {
      const leftSequence = left.record?.sequence;
      const rightSequence = right.record?.sequence;
      if (Number.isInteger(leftSequence) && Number.isInteger(rightSequence)) return leftSequence - rightSequence;
      const leftYear = left.record?.start?.year ?? left.record?.end?.year ?? 9999;
      const rightYear = right.record?.start?.year ?? right.record?.end?.year ?? 9999;
      return leftYear - rightYear || left.entity_id.localeCompare(right.entity_id);
    })
    .map(item => item.record?.party_label || item.record?.party_id || (item.record?.party_ids || []).join(', '))
    .filter(Boolean)
    .join(' → ');
}

function hasExactDuplicate(records) {
  const seen = new Set();
  for (const item of records) {
    const comparable = { ...item.record };
    delete comparable.sequence;
    const key = canonicalStringify(comparable);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

const legacyRows = boats.filter(boat => boat.agare && !ownerships.some(item => item.record?.boat_id === boat.id)).map(boat => {
  const row = {
    boat_id: boat.id,
    boat_name: boat.namn || boat.visningsnamn || 'Namn okänt',
    owner_text: boat.agare,
    observation_year: Number.isInteger(boat.ar) ? boat.ar : null,
    source_labels: boat.kallor_text || [],
    ...linksForBoat(boat.id),
    review_kind: 'insert',
    review_reason: legacyAudits.get(boat.id) || null,
  };
  return { ...row, classification: classification(row) };
}).sort((left, right) => left.boat_name.localeCompare(right.boat_name, 'sv'));

const manualAudits = new Map([
  ['borelia', {
    classification: 'ofullstandig_strukturerad_agarpart',
    review_reason: 'Registerbladet anger ”BRODER (KARL-)PÄR M.FL.”, medan den strukturerade posten bara anger Pär Åkerman.',
  }],
  ['inga', {
    classification: 'strukturerad_agarkedja_att_granska',
    review_reason: 'En odaterad ägarbytesanmälan säger att Björn-Tor och Eva inte längre äger Inga och att den nya ägaren är okänd. Den nuvarande öppna Björn-posten behöver därför avslutas eller följas av en okänd ägarpart utan påhittat årtal.',
  }],
  ['måndag', {
    classification: 'strukturerad_agarkedja_att_granska',
    review_reason: 'Källan anger Kalle och Bibbi från mitten av 1950-talet eller något senare, därefter Britt-Marie och Svante från 1986. Kedjan är i sak införd men person-set-posterna saknar stabila person-ID:n och behöver länkas.',
  }],
  ['roger', {
    classification: 'strukturerad_agarkedja_att_granska',
    review_reason: 'Avregistreringen 2008 anger Monika och Jan Boson följt av köparen ”Farbror Roger”. Kedjan är införd men första posten saknar stabila person-ID:n; Roger ska förbli extern person tills identiteten är känd.',
  }],
  ['sjövild', {
    classification: 'strukturerat_samagande_att_granska',
    review_reason: 'Ansökan 1957 knyter Sten och Karin Dalaryd gemensamt till Sjövild. Befintlig samägarpost saknar stabila person-ID:n och behöver länkas till båda personerna.',
  }],
  ['glädjeflickan', {
    classification: 'strukturerat_samagande_att_granska',
    review_reason: 'Karin och Stens ansökan 1976 beskriver Glädjeflickan som Sjövilds efterträdare. Befintlig samägarpost saknar stabila person-ID:n och behöver länkas till båda personerna.',
  }],
  ['mostergitte', {
    classification: 'strukturerat_samagande_att_granska',
    review_reason: 'Ansökan 2007 beskriver ”vår nyinköpta båt” och undertecknas av Kaj, Helene, Måns och Ola. Kontrollera att den befintliga person-set-posten avsiktligt betyder samtidiga ägare.',
  }],
  ['ctesderhone', {
    classification: 'strukturerat_samagande_att_granska',
    review_reason: 'Ansökan talar om ”våran båt” och är undertecknad av Johan-Anders och Nils. Befintlig person-set saknar stabila person-ID:n och behöver länkas till båda personerna.',
  }],
]);

const structuredRows = boats.flatMap(boat => {
  const existing = ownerships.filter(item => item.record?.boat_id === boat.id);
  const manual = manualAudits.get(boat.id);
  const hasPersonSet = existing.some(item => item.record?.party_type === 'person-set');
  const ordered = [...existing].sort((left, right) => Number(left.record?.sequence || 0) - Number(right.record?.sequence || 0));
  const completeTransitionChain = ordered.length > 1
    && ordered.every((item, index) => item.record?.sequence === index + 1 && item.record?.transition_id)
    && ordered.slice(1).every((item, index) => item.record.transition_id === ordered[index].record.transition_id
      && item.record.start?.year === ordered[index].record.end?.year);
  if (!manual && completeTransitionChain) return [];
  if (!manual && existing.length < 2 && !hasPersonSet) return [];
  const duplicate = hasExactDuplicate(existing);
  const classificationName = manual?.classification || (duplicate
    ? 'strukturerad_dubblett_att_ratta'
    : existing.length > 1 ? 'strukturerad_agarkedja_att_granska' : 'strukturerat_samagande_att_granska');
  const reason = manual?.review_reason || (duplicate
    ? 'Två befintliga ägarposter har samma part, tid och källor.'
    : existing.length > 1
      ? 'Båten har flera strukturerade ägarposter. Kontrollera att de är en ägarföljd och inte samägande eller dubbletter.'
      : 'Befintlig person-set måste kontrolleras som verkligt samägande; den får inte dölja ett ägarbyte.');
  return [{
    boat_id: boat.id,
    boat_name: boat.namn || boat.visningsnamn || 'Namn okänt',
    owner_text: ownerText(existing),
    observation_year: Number.isInteger(boat.ar) ? boat.ar : null,
    source_labels: sourceLabelsForOwnership(existing),
    ...linksForBoat(boat.id),
    classification: classificationName,
    review_kind: 'correction',
    review_reason: reason,
    existing_ownerships: structuredClone(existing),
  }];
}).sort((left, right) => {
  const priority = Number(manualAudits.has(right.boat_id)) - Number(manualAudits.has(left.boat_id));
  return priority || left.boat_name.localeCompare(right.boat_name, 'sv');
});

const classificationCounts = Object.fromEntries([...new Set([...legacyRows, ...structuredRows].map(row => row.classification))]
  .sort((left, right) => left.localeCompare(right, 'sv'))
  .map(key => [key, [...legacyRows, ...structuredRows].filter(row => row.classification === key).length]));

const inventory = {
  inventory_version: 2,
  generated_for_pilot: pilotArgument,
  generated_at: new Date().toISOString(),
  total_boats: boats.length,
  already_structured: new Set(ownerships.map(item => item.record?.boat_id).filter(Boolean)).size,
  legacy_owner_rows: legacyRows.length,
  structured_review_rows_count: structuredRows.length,
  without_owner_information: boats.filter(boat => !boat.agare && !ownerships.some(item => item.record?.boat_id === boat.id)).length,
  classification_counts: classificationCounts,
  rows: legacyRows,
  structured_review_rows: structuredRows,
};

const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const markdown = `# Ägargranskning för Båtmasterpiloten\n\n`
  + `Totalt ${inventory.total_boats} båtar. ${inventory.legacy_owner_rows} äldre fritextposter återstår och ${inventory.structured_review_rows_count} redan strukturerade båtar behöver kontrolleras för ägarföljd, samägande eller dubblett.\n\n`
  + `## Befintliga strukturerade poster att kontrollera\n\n| Båt | Nuvarande struktur | Orsak |\n|---|---|---|\n`
  + structuredRows.map(row => `| ${escapeCell(row.boat_name)} | ${escapeCell(ownerText(row.existing_ownerships))} | ${escapeCell(row.review_reason)} |`).join('\n')
  + `\n`;

await mkdir(outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, 'agarinventering.json'), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(resolve(outputRoot, 'agarinventering.md'), markdown);
console.log(JSON.stringify({
  pilot_id: pilotArgument,
  total_boats: inventory.total_boats,
  legacy_owner_rows: inventory.legacy_owner_rows,
  structured_review_rows: inventory.structured_review_rows_count,
  classifications: classificationCounts,
  output: resolve(outputRoot, 'agarinventering.json'),
}, null, 2));
