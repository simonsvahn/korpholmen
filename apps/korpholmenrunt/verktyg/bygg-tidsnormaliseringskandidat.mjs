import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizationForResult } from '../src/record-ranking.js';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APP_ROOT, '../..');
const PRIVATE_ROOT = resolve(process.env.KORPHOLMEN_PRIVATE_ROOT || '/Users/simon/Dropbox/Appar/Korpholmen');
const RACE_ROOT = resolve(PRIVATE_ROOT, 'korpholmenrunt-generation2');
const ACTIVE_POINTER = resolve(RACE_ROOT, 'active.json');
const DEFAULT_DECISIONS = resolve(REPO_ROOT, 'arbetsmaterial/korpholmenrunt-tidsnormalisering-2026-08-16/time-decisions.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const pointer = await readJson(ACTIVE_POINTER);
const sourceMasterPath = resolve(RACE_ROOT, pointer.master_relative_path);
const sourceMasterBytes = await readFile(sourceMasterPath);
if (sha256(sourceMasterBytes) !== pointer.master_sha256) throw new Error('Aktiv Korpholmen runt-master stämmer inte mot pekarens SHA-256. Ingen kandidat skapades.');
const sourceMaster = JSON.parse(sourceMasterBytes);
if (sourceMaster.app !== 'korpholmenrunt' || !Array.isArray(sourceMaster.data?.results)) throw new Error('Källmastern har oväntat format.');
if (sourceMaster.master_revision !== pointer.master_revision) throw new Error('Källmasterns revision stämmer inte mot den aktiva pekaren.');

const revision = sourceMaster.master_revision + 1;
const decisionsPath = resolve(process.env.KORPHOLMEN_RACE_TIME_DECISIONS || DEFAULT_DECISIONS);
const decisionsBytes = await readFile(decisionsPath);
const decisionDocument = JSON.parse(decisionsBytes);
if (!Array.isArray(decisionDocument.decisions)) throw new Error('Tidsbesluten har oväntat format.');
const decisions = new Map(decisionDocument.decisions.map(decision => [decision.id, decision]));
if (decisions.size !== decisionDocument.decisions.length) throw new Error('Tidsbesluten innehåller dubbla resultat-ID:n.');

const defaultOutput = resolve(REPO_ROOT, `arbetsmaterial/korpholmenrunt-tidsnormalisering-2026-08-16/kandidat-revision-${revision}-v4`);
const output = resolve(process.argv[2] || defaultOutput);
const allowedRoot = `${resolve(REPO_ROOT, 'arbetsmaterial')}${sep}`;
if (!`${output}${sep}`.startsWith(allowedRoot)) throw new Error('Kandidaten får endast skrivas under projektets arbetsmaterial/.');

const automatic = [];
const manual = [];
const foundDecisionIds = new Set();
const unchangedResults = sourceMaster.data.results.map(result => {
  const normalization = normalizationForResult(result);
  const decision = decisions.get(result.id);
  if (decision) {
    foundDecisionIds.add(result.id);
    if (String(result.time_raw || '') !== String(decision.expected_time_raw || '')) {
      throw new Error(`Råtiden för ${result.id} har ändrats sedan beslutet. Ingen kandidat skapades.`);
    }
    if (!decision.fields || typeof decision.fields !== 'object') throw new Error(`Tidsbeslutet för ${result.id} saknar fält.`);
    manual.push({ id: result.id, year: result.year, time_raw: result.time_raw, fields: decision.fields, note: decision.note });
  }
  if (normalization) automatic.push({
    id: result.id,
    year: result.year,
    time_raw: result.time_raw,
    duration_seconds: normalization.duration_seconds,
  });
  if (!normalization && !decision) return result;
  return {
    ...result,
    ...(normalization || {}),
    ...(decision?.fields || {}),
    updated_at: '2026-08-16T00:00:00+02:00',
    updated_by: 'candidate:normalize-race-times:v1',
  };
});

const missingDecisionIds = [...decisions.keys()].filter(id => !foundDecisionIds.has(id));
if (missingDecisionIds.length) throw new Error(`Tidsbeslut saknar resultat i aktiv master: ${missingDecisionIds.join(', ')}`);
if (!automatic.length && !manual.length) throw new Error('Inga tidsfält behöver ändras. Ingen kandidat skapades.');
if (unchangedResults.length !== sourceMaster.data.results.length) throw new Error('Antalet resultat ändrades. Ingen kandidat skapades.');
for (let index = 0; index < unchangedResults.length; index += 1) {
  const before = sourceMaster.data.results[index];
  const after = unchangedResults[index];
  if (before.id !== after.id || before.time_raw !== after.time_raw) {
    throw new Error(`Resultatordning, ID eller råtid ändrades vid ${before.id}. Ingen kandidat skapades.`);
  }
}
const changedIds = new Set([...automatic, ...manual].map(item => item.id));
const candidate = {
  ...sourceMaster,
  master_revision: revision,
  updated_at: '2026-08-16T00:00:00+02:00',
  updated_by: 'candidate:normalize-race-times:v1',
  last_change_id: 'candidate:normalize-race-times:v1',
  data: { ...sourceMaster.data, results: unchangedResults },
};
const candidateBytes = jsonBytes(candidate);
const receipt = {
  schema_version: 1,
  status: 'candidate_not_active',
  publication_performed: false,
  activation_performed: false,
  source_active_pointer: ACTIVE_POINTER,
  source_master: sourceMasterPath,
  source_master_revision: sourceMaster.master_revision,
  source_master_sha256: sha256(sourceMasterBytes),
  candidate_master_revision: revision,
  candidate_master_sha256: sha256(candidateBytes),
  automatic_normalizations: automatic,
  automatic_normalization_count: automatic.length,
  manual_time_decisions: manual,
  manual_time_decision_count: manual.length,
  changed_count: changedIds.size,
  decisions_source: decisionsPath,
  decisions_source_sha256: sha256(decisionsBytes),
  rules: [
    'Saknat duration_seconds med entydig M:SS-, M,SS- eller M.SS-tid utan frågetecken normaliseras.',
    'För 2010 och 2011 tolkas M:SS:HH som minuter, sekunder och hundradelar. Hundradelarna bevaras i time_raw men stryks utan avrundning i duration_seconds.',
  ],
  raw_times_unchanged: true,
};
const receiptBytes = jsonBytes(receipt);
const manifest = {
  schema_version: 1,
  app: 'korpholmenrunt',
  status: 'candidate_not_active',
  publication_performed: false,
  activation_performed: false,
  master_revision: revision,
  master_sha256: sha256(candidateBytes),
  base_master_revision: sourceMaster.master_revision,
  base_master_sha256: sha256(sourceMasterBytes),
  automatic_normalizations: automatic.length,
  manual_time_decisions: manual.length,
  changed_results: changedIds.size,
  validations: {
    source_sha256_matches_active_pointer: 'pass',
    result_count_unchanged: candidate.data.results.length === sourceMaster.data.results.length ? 'pass' : 'fail',
    raw_times_unchanged: 'pass',
    active_pointer_unchanged: 'pass',
  },
  files: {
    'master.json': sha256(candidateBytes),
    'receipt.json': sha256(receiptBytes),
  },
};
const manifestBytes = jsonBytes(manifest);
const sums = [
  `${sha256(candidateBytes)}  master.json`,
  `${sha256(receiptBytes)}  receipt.json`,
  `${sha256(manifestBytes)}  manifest.json`,
  '',
].join('\n');

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'master.json'), candidateBytes, { flag: 'wx' }),
  writeFile(resolve(output, 'receipt.json'), receiptBytes, { flag: 'wx' }),
  writeFile(resolve(output, 'manifest.json'), manifestBytes, { flag: 'wx' }),
  writeFile(resolve(output, 'SHA256SUMS.txt'), sums, { flag: 'wx' }),
]);
console.log(JSON.stringify({ output, base_revision: sourceMaster.master_revision, candidate_revision: revision, automatic_normalizations: automatic.length, manual_time_decisions: manual.length, changed_results: changedIds.size, active_pointer_changed: false }, null, 2));
