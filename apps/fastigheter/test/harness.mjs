import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-02');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
let passed = 0;
async function test(name, action) { try { await action(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }

await test('webbappens JavaScript har giltig syntax', () => {
  for (const file of ['src/app.js', 'verktyg/bygg-aktuella-agare.mjs', 'verktyg/skriv-dropbox-aktuella-agare.mjs', 'verktyg/bygg-personmasterkopplingar.mjs', 'verktyg/skriv-dropbox-personmasterkopplingar.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});
await test('den privata startmastern kan byggas deterministiskt och källreferenser valideras', () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-startmaster.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
await test('SQLite-forskningsdatabasen kan byggas utan främmande nyckelfel', () => {
  const result = spawnSync('python3', ['verktyg/bygg-sqlite.py'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const document = await readJson(resolve(PRIVATE, 'initial-ops.json'));
const source = await readJson(resolve(ROOT, 'privat/kallkopior/fastighetshistorik.json'));
const state = materialize(document.operations);

await test('operationerna är giltiga och mastern har alla fastigheter', () => {
  document.operations.forEach(validateOperation);
  assert.equal(state.listEntities('property').length, 34);
  assert.equal(state.listEntities('audit-finding').length, 32);
  assert.equal(state.listEntities('community-link').length, 137);
  assert.equal(state.listEntities('current-owner-assessment').length, 31);
  assert.ok(state.listEntities('event').length >= 10);
  assert.ok(state.listEntities('holding').length >= 70);
  assert.equal(state.listEntities('manual-claim').length, 130);
  assert.equal(state.listEntities('holding-claim').length, 129);
  assert.ok(state.listEntities('event-claim').length >= 140);
  assert.ok(state.listEntities('evidence').length >= 600);
});
await test('samtliga 130 råposter är normaliserade till en existerande strukturpost', () => {
  const targets = {
    'holding-claim': new Set(state.listEntities('holding-claim').map(item => item.entity_id)),
    'event-claim': new Set(state.listEntities('event-claim').map(item => item.entity_id)),
  };
  for (const item of state.listEntities('manual-claim')) {
    assert.equal(item.fields.normalized, true, item.entity_id);
    assert.ok(targets[item.fields.normalized_entity_type]?.has(item.fields.normalized_entity_id), item.entity_id);
  }
});
await test('alla manuella fastighetsrader har en källgranskning', () => {
  const manual = new Set(source.manual_chains.map(item => item.property_id));
  const audit = new Set(source.audit_findings.map(item => item.property_id));
  assert.equal(manual.size, source.manual_chains.length);
  for (const id of manual) assert.ok(audit.has(id), id);
});
await test('registerobservationer är inte förvärvsdatum', () => {
  const observations = state.listEntities('observation');
  assert.ok(observations.every(item => item.fields.observed_on));
  const observationHoldings = state.listEntities('holding').filter(item => item.fields.basis === 'registerobservation');
  assert.ok(observationHoldings.every(item => item.fields.observed_on && !item.fields.start_date));
  assert.ok(observationHoldings.every(item => item.fields.notes.includes('fastställer inte förvärvsdatum')));
});
await test('nulägesbedömningen rättar ägare utan att skriva över historiken', () => {
  const assessments = new Map(state.listEntities('current-owner-assessment').map(item => [item.fields.property_id, item.fields]));
  const parties = new Map(state.listEntities('party').map(item => [item.entity_id, item.fields]));
  assert.deepEqual(assessments.get('Alsvik 3:343').owner_party_ids.map(id => parties.get(id).person_id), ['olaböving', 'månsböving']);
  assert.deepEqual(assessments.get('Alsvik 3:86').owner_party_ids.map(id => parties.get(id).name), ['Ingrid Gunilla Pettersson']);
  assert.equal(parties.get('party-eva-viveka-larsson').person_id, 'vivekaunelarsson');
  assert.equal(parties.get('party-jonas-petter-gustav-akerman').person_id, 'jonasåkerman');
  assert.equal(parties.get('party-martin-par-olof-liljeros').person_id, 'martinliljeros');
  const currentPartyIds = new Set([...assessments.values()].flatMap(item => item.owner_party_ids || []));
  const currentHumanParties = [...currentPartyIds].map(id => parties.get(id)).filter(party => party.party_type !== 'organisation');
  assert.ok(currentHumanParties.every(party => party.person_id));
  assert.equal(currentHumanParties.filter(party => party.person_id.startsWith('extern-fastighet-')).length, 24);
  assert.equal(parties.get('party-korpholmens-tomtagareforening').person_id, null);
  assert.deepEqual(state.listEntities('observation').find(item => item.fields.property_id === 'Alsvik 3:343').fields.owner_party_ids, ['party-kaj-gunder-boving']);
});
await test('kända transaktionsdatum hålls isär efter datumroll', () => {
  const events = new Map(state.listEntities('event').map(item => [item.entity_id, item.fields]));
  assert.equal(events.get('event-3-24-kop-1897').contract_date, '1897-08-23');
  assert.equal(events.get('event-3-24-kop-1897').survey_date, '1897-08-30');
  assert.equal(events.get('event-3-24-kop-1897').application_date, '1897-09-09');
  assert.deepEqual(events.get('event-3-26-kop-1902').area_claims_ha, [0.815, 0.813]);
  assert.equal(events.get('event-3-39-kop-1916').amount, 600);
});
await test('källkontrollen kodar de viktigaste rättelserna', () => {
  const audits = new Map(state.listEntities('audit-finding').map(item => [item.fields.property_id, item.fields]));
  assert.match(audits.get('Alsvik 3:72').summary, /Anders Olsson/);
  assert.match(audits.get('Alsvik 3:39').summary, /Edla Josefina Öhman/);
  assert.match(audits.get('Alsvik 3:75').summary, /hyresgäster.*inte belagda ägare/);
  assert.match(audits.get('Alsvik 3:53').summary, /exakt transaktionsdatum är okänt/);
});
await test('fastighetsgemenskap kan inte misstolkas som juridiskt ägande', () => {
  for (const link of state.listEntities('community-link')) {
    assert.equal(link.fields.relation, 'fastighetsgemenskap');
    assert.equal(link.fields.legal_ownership, false);
    assert.ok(link.fields.person_id);
  }
});
await test('hyresgäster ligger kvar som råbelägg men märks som icke-ägare', () => {
  const claims = state.listEntities('holding-claim').map(item => item.fields);
  const rentals = claims.filter(item => /hyrde/i.test(item.raw_text));
  assert.ok(rentals.length >= 3);
  assert.ok(rentals.every(item => item.role === 'hyresgäst'));
});
await test('nya källfynd är fältspecifika och bevarar motsägelser', () => {
  const holdings = state.listEntities('holding-claim').map(item => item.fields);
  const events = new Map(state.listEntities('event-claim').map(item => [item.entity_id, item.fields]));
  assert.equal(holdings.find(item => item.property_id === 'Alsvik 3:34' && /Lisa Lindberg/.test(item.holder_text)).role, 'pensionatsinnehavare/verksamhetsutövare');
  assert.ok(holdings.find(item => item.property_id === 'Alsvik 3:55' && /Sigurd Woxell/.test(item.holder_text)).source_ids.includes('TRY-LUNDIN'));
  assert.equal(events.get('claim-3-367-besittning-1957').date_text, 'sommaren 1957');
  assert.equal(events.get('claim-3-84-pris-2004').amount, 3600000);
  assert.equal(events.get('claim-3-84-pris-2009').amount, 3700000);
});
await test('SQLite-exporten har relationstabeller, index och samma kärnräknare', () => {
  const script = `import sqlite3,json; c=sqlite3.connect(r'${resolve(PRIVATE, 'fastighetshistorik.sqlite')}'); print(json.dumps({'properties':c.execute('select count(*) from property').fetchone()[0],'events':c.execute('select count(*) from property_event').fetchone()[0],'event_claims':c.execute('select count(*) from event_claim').fetchone()[0],'holding_claims':c.execute('select count(*) from holding_claim').fetchone()[0],'normalized':c.execute('select count(*) from manual_claim where normalized=1').fetchone()[0],'community':c.execute('select count(*) from community_link').fetchone()[0],'fk':c.execute('pragma foreign_key_check').fetchall()}))`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout); assert.equal(answer.properties, 34); assert.equal(answer.events, state.listEntities('event').length); assert.equal(answer.event_claims, state.listEntities('event-claim').length); assert.equal(answer.holding_claims, 129); assert.equal(answer.normalized, 130); assert.equal(answer.community, 137); assert.deepEqual(answer.fk, []);
});
await test('webbappen kan söka, visa källkontroll och skapa händelser/innehav', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8'); const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(app.includes("opsRoot: '/fastigheter/ops'"));
  assert.ok(app.includes("opsRoot: '/matrikel/ops'"));
  assert.ok(app.includes("opsRoot: '/matrikel/ops', readOnly: true"));
  assert.ok(app.includes("new ReadOnlyMaster({ store, cacheKey: 'matrikel' })"));
  assert.ok(app.includes('resolvePartyName(parties.get(id), matrikelMaster)'));
  assert.ok(app.includes("recordList('current-owner-assessment')"));
  assert.ok(app.includes('Bäst kända nuvarande ägare'));
  assert.ok(app.includes("entityType: 'event'"));
  assert.ok(app.includes("entityType: 'holding'"));
  assert.ok(app.includes('contract_date'));
  assert.ok(app.includes('observed_on'));
  assert.ok(app.includes('data-section="history"><h3>Historik</h3>'));
  assert.ok(app.indexOf('${renderStructuredHistorySection(holdingClaims') < app.indexOf('data-section="identity"'));
  assert.ok(app.includes('Historiska händelseuppgifter'));
  assert.ok(html.includes('data-view="timeline"'));
  assert.ok(html.includes('data-view="audit"'));
});
await test('OAuth-navet känner till den tredje appen', async () => {
  const hub = await readFile(resolve(REPO, 'index.html'), 'utf8');
  const hubApp = await readFile(resolve(REPO, 'src/app.js'), 'utf8');
  assert.ok(hub.includes('./fastigheter/'));
  assert.ok(hubApp.includes('korpholmen:oauth-return'));
  assert.ok(hubApp.includes('mirrorSharedDropboxCredential'));
  assert.ok((await readFile(resolve(ROOT, 'src/app.js'), 'utf8')).includes("new URL('fastigheter/',redirectUri())") || (await readFile(resolve(ROOT, 'src/app.js'), 'utf8')).includes("new URL('fastigheter/', redirectUri())"));
});
await test('publiceringsbygget är datafritt', () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
await test('det datafria paketet har egen offlinebar kärna', async () => {
  const app = await readFile(resolve(REPO, 'fastigheter/src/app.js'), 'utf8');
  const core = await readFile(resolve(REPO, 'fastigheter/core/data-layer.js'), 'utf8');
  const sw = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  assert.ok(app.includes("../core/data-layer.js"));
  assert.ok(core.includes("./storage/indexeddb.js"));
  assert.ok(sw.includes("key.startsWith('korpholmen-fastigheter-')"));
  assert.ok(sw.includes("?'../../packages/core':'./core'"));
});

console.log(`\n${passed} Fastighetshistorik-kontrakt godkända.`);
