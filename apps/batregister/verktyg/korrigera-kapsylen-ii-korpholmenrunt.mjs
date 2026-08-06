import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { compareHLC, createClock, parseHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createSetOperation } from '../../../packages/core/domain/operations.js';
import { batchPath, createBatch, validateBatch } from '../../../packages/core/sync/batch.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const [dropboxArgument] = args.filter(value => value !== '--write');
if (!dropboxArgument) throw new Error('Användning: node korrigera-kapsylen-ii-korpholmenrunt.mjs DROPBOX-ROT [--write]');

const dropboxRoot = await realpath(resolve(dropboxArgument));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error('Avbryter: målet är inte Dropbox/Appar/Korpholmen.');
const deviceId = 'runt-korrigering-kapsylenii-roddbat-20260805';
const opsRoot = resolve(dropboxRoot, 'korpholmenrunt/ops');
const auditRoot = resolve(dropboxRoot, 'korpholmenrunt/korrigeringar/kapsylen-ii-roddbat-20260805');

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

async function writeExact(path, content) {
  try { await writeFile(path, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) throw new Error(`Befintlig fil skiljer sig och skrivs inte över: ${path}`);
  }
}

const batches = await Promise.all((await jsonFiles(opsRoot)).map(async path => {
  const batch = JSON.parse(await readFile(path, 'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOperations = batches.flatMap(batch => batch.ops);
const existingCorrection = existingOperations.filter(operation => operation.device_id === deviceId);
if (existingCorrection.length) {
  console.log(JSON.stringify({ correction_id: deviceId, already_applied: true, operations: existingCorrection.length, audit_root: auditRoot }, null, 2));
  process.exit(0);
}

const state = materialize(existingOperations);
const boat = state.getEntity('boat-ref', 'boat-ref:kapsylenii');
const result = state.getEntity('race-result', 'race-result:analog-img-7402-2010-07');
if (!boat || boat.fields.name !== 'Kapsylen II' || boat.fields.type !== 'K1') throw new Error('Kapsylen II:s båtreferens har ett oväntat före-läge.');
if (!result || result.fields.boat_id !== 'kapsylenii' || result.fields.class_raw !== '[osäkert: 7 K1]') throw new Error('Tävlingsposten för Kapsylen II har ett oväntat före-läge.');

const touched = [boat, result].map(entity => ({
  entity_type: entity.entity_type,
  entity_id: entity.entity_id,
  deleted: entity.deleted ?? null,
  fields: structuredClone(entity.fields),
}));
const reviewIssue = 'Båttypen är rättad till roddbåt enligt Simon Svahn 2026-08-05; den osäkert lästa tävlingsklassen [osäkert: 7 K1] bevaras som källuppgift.';
const entries = [
  ['boat-ref', 'boat-ref:kapsylenii', 'type', 'R/S'],
  ['boat-ref', 'boat-ref:kapsylenii', 'category', 'rowboat'],
  ['boat-ref', 'boat-ref:kapsylenii', 'type_evidence', {
    source_type: 'oral',
    speaker: 'Simon Svahn',
    recorded_at: '2026-08-05',
    statement: 'Kapsylen II är en roddbåt',
  }],
  ['race-result', 'race-result:analog-img-7402-2010-07', 'review_issues', [...new Set([...(result.fields.review_issues || []), reviewIssue])]],
  ['race-result', 'race-result:analog-img-7402-2010-07', 'boat_type_evidence', {
    asserted_category: 'rowboat',
    source_type: 'oral',
    speaker: 'Simon Svahn',
    recorded_at: '2026-08-05',
    statement: 'Kapsylen II är en roddbåt',
    class_interpretation_preserved: true,
  }],
];

const latestHlc = existingOperations.map(operation => operation.hlc)
  .reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
const wallTime = Math.max(Date.now(), latestHlc ? parseHLC(latestHlc).wallTime + 1 : 0);
const clock = createClock(deviceId, () => wallTime, latestHlc);
const operations = entries.map(([entityType, entityId, field, value], index) => createSetOperation({
  deviceId,
  seq: index + 1,
  entityType,
  entityId,
  field,
  value,
  hlc: clock.tick(),
}));
const batch = createBatch(operations);
validateBatch(batch);
const after = materialize([...existingOperations, ...operations]);
const correctedBoat = after.getEntity('boat-ref', 'boat-ref:kapsylenii');
const correctedResult = after.getEntity('race-result', 'race-result:analog-img-7402-2010-07');
if (correctedBoat.fields.type !== 'R/S' || correctedBoat.fields.category !== 'rowboat') throw new Error('Båttypen kunde inte verifieras.');
if (correctedResult.fields.class_raw !== '[osäkert: 7 K1]' || correctedResult.fields.class_id !== 'kajak-1') throw new Error('Originalets osäkra klassuppgift ändrades av misstag.');
if (!correctedResult.fields.review_issues.includes(reviewIssue)) throw new Error('Motsägelseflaggan saknas.');

const afterEntities = touched.map(entry => {
  const entity = after.getEntity(entry.entity_type, entry.entity_id, { includeDeleted: true });
  return { entity_type: entry.entity_type, entity_id: entry.entity_id, deleted: entity?.deleted ?? null, fields: structuredClone(entity?.fields || {}) };
});
const audit = {
  audit_version: 1,
  correction_id: deviceId,
  statement: 'Kapsylen II är en roddbåt',
  interpretation: 'Båttypen rättas. Den osäkra klassläsningen i 2010 års resultat bevaras och flaggas som motsägande källuppgift.',
  before_entities: touched,
  after_entities: afterEntities,
  operation_sha256: createHash('sha256').update(canonicalStringify(operations)).digest('hex'),
  operations,
};
const batchName = basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq));
if (write) {
  await mkdir(auditRoot, { recursive: true });
  await mkdir(opsRoot, { recursive: true });
  await writeExact(resolve(auditRoot, 'revision.json'), `${JSON.stringify(audit, null, 2)}\n`);
  await writeExact(resolve(opsRoot, batchName), `${JSON.stringify(batch, null, 2)}\n`);
}
console.log(JSON.stringify({ correction_id: deviceId, dry_run: !write, operations: operations.length, batch: batchName, audit_root: auditRoot }, null, 2));
