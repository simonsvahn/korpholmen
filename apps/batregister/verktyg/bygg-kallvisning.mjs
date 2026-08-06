import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument, sourceRootArgument, pilotId] = process.argv.slice(2);
if (!boatOpsArgument || !sourceRootArgument || !pilotId) {
  throw new Error('Användning: node bygg-kallvisning.mjs BATREGISTER-OPS KÄLLROT PILOT-ID');
}
if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(pilotId)) throw new Error('Pilot-id är ogiltigt.');

const boatOpsRoot = resolve(boatOpsArgument);
const sourceRoot = await realpath(resolve(sourceRootArgument));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(root, 'privat/piloter', pilotId);
const assetRoot = resolve(outputRoot, 'kallor');
const manifestPath = resolve(outputRoot, 'kallmanifest.json');
const inventoryPath = resolve(outputRoot, 'agarinventering.json');
const susannaKbkRoot = await realpath('/Users/simon/Dropbox/Documents/Privat/Susanna/Arkiv/Övrigt/Korpholmens båtklubb');
const registerRoot = resolve(sourceRoot, 'källmaterial/07 KBK-arkivet/Båtar 2 - Scannade av Broder Peter-Pedal (Holm)');

async function files(path, predicate = () => true) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && predicate(child)) output.push(child);
    }
  }
  await visit(path);
  return output.sort();
}

async function loadMaster(path) {
  const batches = await Promise.all((await files(path, file => file.endsWith('.json'))).map(async file => {
    const batch = JSON.parse(await readFile(file, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  return materialize(batches.flatMap(batch => batch.ops));
}

const boatState = await loadMaster(boatOpsRoot);
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
if (inventory.generated_for_pilot !== pilotId || !Array.isArray(inventory.rows)) throw new Error('Ägarinventeringen hör inte till piloten.');

const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sourceRecords = boatState.listEntities('boat-source').map(entity => entity.fields.record).filter(source => source?.id);
const sourceById = new Map(sourceRecords.map(source => [source.id, source]));
const registerFiles = (await readdir(registerRoot)).filter(name => name.toLowerCase().endsWith('.pdf')).sort();
const manifestEntries = new Map();
const boatSourceIds = new Map();
const copiedAssets = new Map();

function linkBoat(boatId, sourceId) {
  if (!boatSourceIds.has(boatId)) boatSourceIds.set(boatId, new Set());
  boatSourceIds.get(boatId).add(sourceId);
}

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  return ({
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
  })[extension] || 'application/octet-stream';
}

function allowed(path) {
  return path === sourceRoot || path.startsWith(`${sourceRoot}/`) || path === susannaKbkRoot || path.startsWith(`${susannaKbkRoot}/`);
}

async function artifact(path, { label, role }) {
  const actual = await realpath(path);
  if (!allowed(actual)) throw new Error(`Källfilen ligger utanför tillåtna källrötter: ${actual}`);
  const bytes = await readFile(actual);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = extname(actual).toLowerCase() || '.bin';
  const filename = `${sha256}${extension}`;
  if (!copiedAssets.has(filename)) {
    await copyFile(actual, resolve(assetRoot, filename));
    copiedAssets.set(filename, bytes.length);
  }
  return {
    artifact_id: `${sha256}:${role}`,
    label,
    role,
    filename: basename(actual),
    mime_type: mimeType(actual),
    web_path: `kallor/${filename}`,
    sha256,
    bytes: bytes.length,
  };
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function relatedPaths(primaryPath) {
  if (!['.md', '.txt'].includes(extname(primaryPath).toLowerCase())) return [];
  const output = [];
  const text = await readFile(primaryPath, 'utf8');
  const directory = dirname(primaryPath);
  const prefix = basename(primaryPath).replace(/ – (?:avskrift|textextrakt).*$/i, '');
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || name === basename(primaryPath)) continue;
    if (!/ – (?:original|beskuren|innehållsbild) – /i.test(name)) continue;
    const role = / – original – /i.test(name) ? 'original' : / – beskuren – /i.test(name) ? 'läsbild' : 'bilaga';
    output.push({ path: resolve(directory, name), label: role === 'original' ? 'Originalfoto' : role === 'läsbild' ? 'Läsbild' : 'Bilaga', role });
  }
  const header = text.split('\n').slice(0, 90).join('\n');
  for (const match of header.matchAll(/\[([^\]]+)\]\(<([^>]+)>\)/g)) {
    if (/^[a-z]+:\/\//i.test(match[2])) continue;
    const path = resolve(directory, match[2]);
    if (await exists(path)) output.push({ path, label: match[1] || 'Original', role: 'original' });
  }
  for (const match of header.matchAll(/`(\/Users\/simon\/Dropbox\/[^`]+\.(?:pdf|jpe?g|png|heic|heif|tiff?))`/gi)) {
    if (await exists(match[1])) output.push({ path: match[1], label: 'Original', role: 'original' });
  }
  return output;
}

async function addManifestSource(source, localStatus = 'master') {
  if (manifestEntries.has(source.id)) return manifestEntries.get(source.id);
  const artifacts = [];
  if (source.relative_path) {
    const primaryPath = resolve(sourceRoot, source.relative_path);
    if (await exists(primaryPath)) {
      const extension = extname(primaryPath).toLowerCase();
      const textCopy = ['.md', '.txt', '.csv'].includes(extension);
      artifacts.push(await artifact(primaryPath, { label: textCopy ? 'Avskrift' : 'Original', role: textCopy ? 'avskrift' : 'original' }));
      for (const related of await relatedPaths(primaryPath)) artifacts.push(await artifact(related.path, related));
    }
  }
  const uniqueArtifacts = [...new Map(artifacts.map(item => [`${item.sha256}:${item.role}`, item])).values()];
  const entry = { local_status: localStatus, source: structuredClone(source), artifacts: uniqueArtifacts };
  manifestEntries.set(source.id, entry);
  for (const boatId of source.entity_ids || []) linkBoat(boatId, source.id);
  return entry;
}

await mkdir(assetRoot, { recursive: true });
for (const source of sourceRecords) await addManifestSource(source);

const lillaKraketSourcePath = resolve(registerRoot, 'Gösta Jansson.pdf');
if (await exists(lillaKraketSourcePath)) {
  const bytes = await readFile(lillaKraketSourcePath);
  await addManifestSource({
    id: 'source:owner-change-lillakraket-1996',
    label: 'Registerkort: Lilla Kräket – ägare bytt 1996',
    kind: 'register-leaf',
    source_date: 1996,
    relative_path: relative(sourceRoot, lillaKraketSourcePath),
    master_path: null,
    entity_ids: ['lillakräket'],
    speaker: null,
    recorded_at: null,
    statement: 'Ägare bytt till MARTIN ÅKERMAN (1996)',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    authority_for: ['ownership change', 'previous owner', 'owner'],
  }, 'proposed');
}

const ownerEvidence = [
  {
    base_id: 'source:d26-mandag-2009', id: 'source:owner-evidence-mandag-2009', entity_ids: ['måndag'],
    label: 'Ägarkedja för Måndag 1950-tal–2009',
    statement: 'Båten har varit i vår ägo sedan 1986. Tidigare ägare var Kalle och Bibbi som haft Måndag sedan mitten av 1950-talet eller något senare.',
  },
  {
    base_id: 'source:d26-roger-2008', id: 'source:owner-evidence-roger-2008', entity_ids: ['roger'],
    label: 'Ägarbyte för Roger 2008', statement: 'M/S Roger avregistreras 2008; köpare anges som Farbror Roger och handlingen undertecknas av Monika och Jan Boson.',
  },
  {
    base_id: 'source:d26-hostsol-2009', id: 'source:owner-evidence-hostsol-2009', entity_ids: ['höstsol'],
    label: 'Ägar- och avgångsuppgift för Höstsol 2009', statement: 'Höstsol hade varit i avsändarnas ägo i 6–7 år och lämnade därefter till Oskarshamns skärgård.',
  },
  {
    base_id: 'source:d26-scandica-curre', id: 'source:owner-evidence-inga-transfer', entity_ids: ['inga'],
    label: 'Ägarbytesanmälan för Inga', statement: 'Björn-Tor och Eva meddelar att Inga inte längre är i deras ägo; den nya ägarens namn och tidpunkten anges inte.',
  },
  {
    base_id: 'source:d26-sjovild-1957', id: 'source:owner-evidence-sjovild-1957', entity_ids: ['sjövild'],
    label: 'Sten och Karin med Sjövild 1957', statement: 'Sten och Karin ansöker gemensamt om att ”Sjövild och vi” ska få vara med i klubben.',
  },
  {
    base_id: 'source:d26-gladjeflickan-1976', id: 'source:owner-evidence-gladjeflickan-1976', entity_ids: ['glädjeflickan'],
    label: 'Karin och Sten med Glädjeflickan 1976', statement: 'Karin och Sten beskriver Glädjeflickan som Sjövilds efterträdare och ansöker gemensamt om namnet.',
  },
  {
    base_id: 'source:d26-moster-gitte-2007', id: 'source:owner-evidence-moster-gitte-2007', entity_ids: ['mostergitte'],
    label: 'Ägaruppgift för Moster Gitte 2007', statement: 'Kaj, Helene, Måns och Ola beskriver Linder 460 som ”vår nyinköpta båt”.',
  },
  {
    base_id: 'source:d26-cotes-spec', id: 'source:owner-evidence-cotes-de-rhone', entity_ids: ['ctesderhone'],
    label: 'Ägaruppgift för Côtes de Rhône', statement: 'Johan-Anders och Nils ansöker gemensamt om medlemskap för ”våran båt”.',
  },
];

for (const evidence of ownerEvidence) {
  const base = sourceById.get(evidence.base_id);
  if (!base?.relative_path) continue;
  const path = resolve(sourceRoot, base.relative_path);
  if (!await exists(path)) continue;
  const bytes = await readFile(path);
  await addManifestSource({
    ...structuredClone(base),
    id: evidence.id,
    label: evidence.label,
    entity_ids: evidence.entity_ids,
    statement: evidence.statement,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    authority_for: ['owner statement', 'ownership change', 'previous owner'],
  }, 'proposed');
}

const commonLegacySources = new Map([
  ['Matrikel 1980', 'source:matrikel-1980-1986-transcript'],
  ['Matrikel 1986', 'source:matrikel-1980-1986-transcript'],
  ['Matrikel 1996', 'source:matrikel-1996-transcript'],
  ['Protokoll 2013', 'source:protocol-2013'],
]);

for (const row of inventory.rows) {
  for (const label of row.source_labels || []) {
    const commonId = commonLegacySources.get(label) || (label.startsWith('TRY-MAMMA') ? 'source:lena-boving-2019' : null);
    if (commonId && sourceById.has(commonId)) linkBoat(row.boat_id, commonId);
  }
  if (!(row.source_labels || []).includes('Registerblad (Båtar 2)')) continue;
  const keys = new Set([
    row.boat_id,
    row.boat_name,
    ...String(row.boat_name || '').split(/[\/]/),
    String(row.boat_name || '').replace(/^\s*[MRS]\/?S\s+/i, '').replace(/\s*\([^)]*\)\s*/g, ''),
  ].map(normalize).filter(Boolean));
  const matches = registerFiles.filter(name => keys.has(normalize(basename(name, extname(name)))));
  const existing = sourceRecords.find(source => (source.entity_ids || []).includes(row.boat_id)
    && source.relative_path && matches.some(name => normalize(basename(source.relative_path)) === normalize(name)));
  if (existing) {
    linkBoat(row.boat_id, existing.id);
    continue;
  }
  if (matches.length === 1) {
    const name = matches[0];
    const path = resolve(registerRoot, name);
    const bytes = await readFile(path);
    const source = {
      id: `source:owner-register-${row.boat_id}`,
      label: `Registerblad för ${row.boat_name}`,
      kind: 'register-leaf',
      source_date: null,
      relative_path: relative(sourceRoot, path),
      master_path: null,
      entity_ids: [row.boat_id],
      speaker: null,
      recorded_at: null,
      statement: null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      authority_for: ['owner as written on register leaf', 'vessel identity', 'registration observation'],
    };
    await addManifestSource(source, 'proposed');
  } else if (matches.length > 1) {
    for (const [index, name] of matches.entries()) {
      const path = resolve(registerRoot, name);
      const bytes = await readFile(path);
      const source = {
        id: `candidate:owner-register-${row.boat_id}-${index + 1}`,
        label: `Möjligt registerblad: ${name}`,
        kind: 'register-leaf-candidate',
        source_date: null,
        relative_path: relative(sourceRoot, path),
        master_path: null,
        entity_ids: [row.boat_id],
        speaker: null,
        recorded_at: null,
        statement: null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authority_for: [],
      };
      await addManifestSource(source, 'candidate');
    }
  }
}

const manifest = {
  source_view_manifest_version: 1,
  pilot_id: pilotId,
  generated_at: new Date().toISOString(),
  sources: [...manifestEntries.values()].sort((left, right) => left.source.label.localeCompare(right.source.label, 'sv')),
  boat_source_ids: Object.fromEntries([...boatSourceIds.entries()].sort(([left], [right]) => left.localeCompare(right, 'sv')).map(([boatId, ids]) => [boatId, [...ids].sort()])),
  counts: {
    source_entries: manifestEntries.size,
    master_sources: [...manifestEntries.values()].filter(entry => entry.local_status === 'master').length,
    proposed_sources: [...manifestEntries.values()].filter(entry => entry.local_status === 'proposed').length,
    candidate_sources: [...manifestEntries.values()].filter(entry => entry.local_status === 'candidate').length,
    sources_with_artifacts: [...manifestEntries.values()].filter(entry => entry.artifacts.length).length,
    copied_files: copiedAssets.size,
    copied_bytes: [...copiedAssets.values()].reduce((sum, value) => sum + value, 0),
    boats_with_sources: boatSourceIds.size,
  },
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ manifest: manifestPath, ...manifest.counts }, null, 2));
