import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument, matrikelOpsArgument, sourceRootArgument] = process.argv.slice(2);
if (!boatOpsArgument || !matrikelOpsArgument || !sourceRootArgument) {
  throw new Error('Användning: node bygg-agarmigreringspilot.mjs BATREGISTER-OPS MATRIKEL-OPS KÄLLROT');
}

const boatOpsRoot = resolve(boatOpsArgument);
const matrikelOpsRoot = resolve(matrikelOpsArgument);
const sourceRoot = resolve(sourceRootArgument);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pilotId = 'batmaster-pilot-agarmigrering-20260806-a';
const outputRoot = resolve(root, 'privat/piloter', pilotId);
const planPath = resolve(outputRoot, 'plan.json');
const inventoryPath = resolve(outputRoot, 'agarinventering.json');
const inventoryMarkdownPath = resolve(outputRoot, 'agarinventering.md');
const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];

async function files(rootPath, predicate = () => true) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && predicate(child)) output.push(child);
    }
  }
  await visit(rootPath);
  return output.sort();
}

async function loadMaster(opsRoot) {
  const batches = await Promise.all((await files(opsRoot, path => path.endsWith('.json'))).map(async path => {
    const batch = JSON.parse(await readFile(path, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  return materialize(batches.flatMap(batch => batch.ops));
}

const boatState = await loadMaster(boatOpsRoot);
const matrikelState = await loadMaster(matrikelOpsRoot);
const boats = boatState.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const ownership = boatState.listEntities('boat-ownership-observation').map(entity => ({ id: entity.entity_id, ...entity.fields.record }));
const personLinks = boatState.listEntities('boat-person-link').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const familyLinks = boatState.listEntities('boat-family-link').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const sourceFiles = await files(sourceRoot);

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

const inventoryRows = boats
  .filter(boat => boat.agare && !ownership.some(owner => owner.boat_id === boat.id))
  .map(boat => {
    const row = {
      boat_id: boat.id,
      boat_name: boat.namn || boat.visningsnamn || 'Namn okänt',
      owner_text: boat.agare,
      observation_year: Number.isInteger(boat.ar) ? boat.ar : null,
      source_labels: boat.kallor_text || [],
      person_links: personLinks.filter(link => link.boat_id === boat.id).map(link => ({
        person_id: link.person_id,
        stored_name: link.person_display_name,
        role: link.role,
        confidence: link.confidence,
        mapping_source: link.source,
        person_exists_in_matrikel: Boolean(matrikelState.getEntity('person', link.person_id)),
      })),
      family_links: familyLinks.filter(link => link.boat_id === boat.id).map(link => ({
        legacy_family_id: link.family_id,
        legacy_family_name: link.family_name,
        role: link.role,
        confidence: link.confidence,
        mapping_source: link.source,
      })),
    };
    return { ...row, classification: classification(row) };
  })
  .sort((left, right) => left.boat_name.localeCompare(right.boat_name, 'sv'));

const inventoryCounts = Object.fromEntries([...new Set(inventoryRows.map(row => row.classification))]
  .sort((left, right) => left.localeCompare(right, 'sv'))
  .map(key => [key, inventoryRows.filter(row => row.classification === key).length]));
const inventory = {
  inventory_version: 1,
  generated_for_pilot: pilotId,
  total_boats: boats.length,
  already_structured: boats.filter(boat => ownership.some(owner => owner.boat_id === boat.id)).length,
  legacy_owner_rows: inventoryRows.length,
  without_owner_information: boats.filter(boat => !boat.agare && !ownership.some(owner => owner.boat_id === boat.id)).length,
  classification_counts: inventoryCounts,
  rows: inventoryRows,
};

const selected = [
  ['aeola', 'johanhedström', 'Aeola.pdf'],
  ['agro', 'björnsöderberg', 'Agro.pdf'],
  ['babbb', 'hasseune', 'Babbb.pdf'],
  ['blådåren', 'ellaböving', 'Blådåren.pdf'],
  ['borelia', 'päråkerman', 'Borelia.pdf'],
  ['dristigheten', 'johanhedström', 'Dristigheten.pdf'],
  ['egolast', 'ellaböving', 'Egolast.pdf'],
  ['emiliagolin', 'johanhedström', 'Emilia Golin.pdf'],
  ['göstajansson', 'görvelåkerman', 'Gösta Jansson.pdf'],
  ['gulligamauritz', 'kajböving', 'Gulliga Mauritz.pdf'],
  ['inga', 'björnsöderberg', 'Inga.pdf'],
  ['karljohan', 'johanåkerman', 'Karl Johan.pdf'],
  ['lilleerik', 'matsåkerman', 'Lille Erik.pdf'],
  ['tranan', 'johanåkerman', 'Tranan alias Korpen.pdf'],
  ['tummen', 'janböving', 'Tummen.pdf'],
].map(([boatId, personId, filename]) => ({ boatId, personId, filename }));

const sources = [];
const records = [];
const requirements = new Map();
for (const item of selected) {
  const boat = boats.find(candidate => candidate.id === item.boatId);
  const inventoryRow = inventoryRows.find(row => row.boat_id === item.boatId);
  const person = matrikelState.getEntity('person', item.personId);
  if (!boat || !inventoryRow || !person) throw new Error(`Pilotposten saknas i en master: ${item.boatId} → ${item.personId}`);
  if (ownership.some(owner => owner.boat_id === item.boatId)) throw new Error(`Båten har redan strukturerad ägare: ${item.boatId}`);
  if (!inventoryRow.person_links.some(link => link.person_id === item.personId)) throw new Error(`Den äldre kopplingen saknas: ${item.boatId} → ${item.personId}`);
  const normalizedFilename = item.filename.normalize('NFC');
  const matches = sourceFiles.filter(path => basename(path).normalize('NFC') === normalizedFilename
    && relative(sourceRoot, path).normalize('NFC').includes('Båtar 2 - Scannade av Broder Peter-Pedal (Holm)'.normalize('NFC')));
  if (matches.length !== 1) throw new Error(`${item.filename} gav ${matches.length} originalträffar.`);
  const sourceId = `source:boats2-owner-${item.boatId}`;
  const sourcePathHint = relative(sourceRoot, matches[0]).split('/').slice(0, -1).join('/');
  sources.push({
    id: sourceId,
    label: `Registerblad för ${boat.namn || boat.visningsnamn || item.boatId}`,
    kind: 'register-leaf',
    filename: basename(matches[0]),
    path_contains: sourcePathHint,
    source_date: null,
    entity_ids: [item.boatId],
    authority_for: ['owner as written on register leaf', 'vessel identity', 'registration observation'],
  });
  const record = {
    boat_id: item.boatId,
    role: 'owner',
    party_type: 'person',
    party_id: item.personId,
    party_label: person.fields.display_name,
    start: Number.isInteger(boat.ar) ? { year: boat.ar, precision: 'observed' } : null,
    end: null,
    status: 'accepted',
    source_ids: [sourceId],
    legacy_owner_text: boat.agare,
  };
  records.push({ entity_type: 'boat-ownership-observation', entity_id: `owner:${item.boatId}:boats2-register`, record });
  requirements.set(item.personId, {
    master: 'matrikel', entity_type: 'person', entity_id: item.personId,
    expect: { display_name: person.fields.display_name },
  });
}

const expectedCounts = Object.fromEntries(countedTypes.map(type => [type, boatState.listEntities(type).length]));
const plan = {
  schema_version: 1,
  pilot_id: pilotId,
  model_version: 'boat-master-owner-migration-v1',
  label: 'Båtmaster · strukturerade ägare, första källkontrollerade urvalet',
  supersedes: 'batmaster-pilot-alla-batar-20260805-e',
  scope: 'Alla kända båtar: ägarvisning via Matrikelmastern och första källkontrollerade ägarurvalet',
  boat_ids: boats.map(boat => boat.id),
  expected_counts: expectedCounts,
  linked_master_requirements: [...requirements.values()],
  sources,
  records,
  changes: [],
  verify: records.map(record => ({ entity_type: record.entity_type, entity_id: record.entity_id, fields: { record: record.record } })),
  ownership_inventory: inventory,
  selected_migrations: selected,
};

const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const inventoryMarkdown = `# Ägarinventering för Båtmasterpiloten\n\n`
  + `Totalt ${inventory.total_boats} båtar. ${inventory.already_structured} har strukturerade ägarposter, ${inventory.legacy_owner_rows} har äldre ägarfritext och ${inventory.without_owner_information} saknar ägaruppgift.\n\n`
  + `## Klasser\n\n${Object.entries(inventoryCounts).map(([key, count]) => `- ${key}: ${count}`).join('\n')}\n\n`
  + `## Alla fritextposter\n\n| Båt | Äldre ägartext | Klass | Personkandidater |\n|---|---|---|---|\n`
  + inventoryRows.map(row => `| ${escapeCell(row.boat_name)} | ${escapeCell(row.owner_text)} | ${escapeCell(row.classification)} | ${escapeCell(row.person_links.map(link => link.stored_name || link.person_id).join(', '))} |`).join('\n')
  + `\n`;

await mkdir(outputRoot, { recursive: true });
await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(inventoryMarkdownPath, inventoryMarkdown);
console.log(JSON.stringify({
  pilot_id: pilotId,
  plan: planPath,
  inventory_json: inventoryPath,
  inventory_markdown: inventoryMarkdownPath,
  inventory_counts: inventoryCounts,
  selected_owners: selected.length,
}, null, 2));
