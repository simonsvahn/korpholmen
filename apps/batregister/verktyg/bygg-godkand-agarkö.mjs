import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';
import {
  normalizeOwnerReviewDocument,
  sourceSupportsOwnership,
  validateOwnerChangeQueue,
} from '../src/owner-review-decisions.js';

const [exportArgument, boatOpsArgument, sourceRelativeArgument, outputArgument] = process.argv.slice(2);
if (!exportArgument || !boatOpsArgument || !sourceRelativeArgument || !outputArgument) {
  throw new Error('Användning: node bygg-godkand-agarkö.mjs ÄGAREXPORT BATREGISTER-OPS KÄLLSÖKVÄG UTDATA-KÖ');
}

const exportPath = resolve(exportArgument);
const boatOpsRoot = resolve(boatOpsArgument);
const outputPath = resolve(outputArgument);
const sourceRelativePath = sourceRelativeArgument.replace(/^\/+/, '');
const exportText = await readFile(exportPath, 'utf8');
const exportDocument = JSON.parse(exportText);
const document = normalizeOwnerReviewDocument(exportDocument, exportDocument.pilot_id);
const exportSha256 = createHash('sha256').update(exportText).digest('hex');

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

const operations = [];
for (const path of await jsonFiles(boatOpsRoot)) {
  const batch = JSON.parse(await readFile(path, 'utf8'));
  validateBatch(batch);
  operations.push(...batch.ops);
}
const state = materialize(operations);
const masterSources = new Map(state.listEntities('boat-source').map(entity => [entity.entity_id, entity.fields.record]));
const decisions = Object.values(document.decisions).sort((left, right) => left.boat_id.localeCompare(right.boat_id, 'sv'));
if (!decisions.length) throw new Error('Ägarexporten innehåller inga beslut.');
const approvedAt = new Date(Math.max(...decisions.map(decision => Date.parse(decision.updated_at) || 0))).toISOString();

const reviewSourceId = `source:owner-review:${exportSha256.slice(0, 16)}`;
const reviewSource = {
  id: reviewSourceId,
  label: 'Godkänd manuell ägargranskning',
  kind: 'review-decision',
  source_date: approvedAt.slice(0, 10),
  relative_path: sourceRelativePath,
  master_path: `/${sourceRelativePath}`,
  entity_ids: decisions.map(decision => decision.boat_id),
  speaker: null,
  recorded_at: null,
  statement: 'Personkopplingar och angivna år är manuellt granskade och godkända. Övriga båtuppgifter lämnas oförändrade.',
  sha256: exportSha256,
  authority_for: ['owner identity', 'ownership period'],
};

const sourceForBoat = (boatId, predicate) => [...masterSources.values()].filter(source =>
  (source.entity_ids || []).includes(boatId) && predicate(source));
const droppedSourceIds = [];
const remappedSourceIds = [];

const approvedDecisions = decisions.map(decision => ({
  decision_id: decision.decision_id,
  boat_id: decision.boat_id,
  boat_name: state.getEntity('boat', decision.boat_id)?.fields.namn || decision.boat_id,
  source_owner_text: decision.source_owner_text,
  mode: decision.mode || 'insert',
  expected_ownerships: structuredClone(decision.expected_ownerships || []),
  note: decision.note || null,
  ownerships: decision.ownerships.map(proposal => {
    const sourceIds = [];
    for (const sourceId of proposal.source_ids || []) {
      const source = masterSources.get(sourceId);
      if (source && (source.entity_ids || []).includes(decision.boat_id)) {
        sourceIds.push(sourceId);
        continue;
      }
      if (sourceId.startsWith('source:owner-register-')) {
        const matches = sourceForBoat(decision.boat_id, candidate => candidate.kind === 'register-leaf' && candidate.relative_path);
        if (matches.length === 1) {
          sourceIds.push(matches[0].id);
          remappedSourceIds.push({ boat_id: decision.boat_id, from: sourceId, to: matches[0].id });
          continue;
        }
      }
      droppedSourceIds.push({ boat_id: decision.boat_id, source_id: sourceId });
    }
    for (const source of sourceForBoat(decision.boat_id, sourceSupportsOwnership)) sourceIds.push(source.id);
    sourceIds.push(reviewSourceId);
    return { ...structuredClone(proposal), source_ids: [...new Set(sourceIds)] };
  }),
}));

const referencedSourceIds = new Set(approvedDecisions.flatMap(decision => decision.ownerships.flatMap(proposal => proposal.source_ids)));
const sources = [reviewSource];
for (const sourceId of [...referencedSourceIds].sort()) {
  if (sourceId === reviewSourceId) continue;
  const source = masterSources.get(sourceId);
  if (!source) throw new Error(`Den godkända kön refererar en okänd masterkälla: ${sourceId}`);
  sources.push(structuredClone(source));
}

const queue = {
  change_queue_version: 3,
  source_document_version: document.document_version,
  pilot_id: document.pilot_id,
  exported_at: approvedAt,
  approval: {
    approved_by: 'manual-review',
    approved_on: approvedAt.slice(0, 10),
    export_sha256: exportSha256,
    policy: 'Alla exporterade personkopplingar och år behandlas som godkända bästa uppgift; övrig masterdata bevaras.',
  },
  sources,
  decisions: approvedDecisions,
};
validateOwnerChangeQueue(queue);

const queueText = `${JSON.stringify(queue, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
try {
  await writeFile(outputPath, queueText, { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (await readFile(outputPath, 'utf8') !== queueText) throw new Error(`En annan godkänd kö finns redan och skrivs inte över: ${outputPath}`);
}

console.log(JSON.stringify({
  queue: outputPath,
  decisions: approvedDecisions.length,
  ownership_records: approvedDecisions.reduce((sum, decision) => sum + decision.ownerships.length, 0),
  source_records: sources.length,
  review_source_id: reviewSourceId,
  export_sha256: exportSha256,
  remapped_source_ids: remappedSourceIds,
  dropped_unlinked_source_ids: droppedSourceIds,
}, null, 2));
