import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = resolve(ROOT, 'privat/kallkopior/fastighetshistorik.json');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-02');
const MATRIKEL = resolve(ROOT, '../personer-familjer/privat/migrering-2026-08-01');
const MATRIKEL_EXTERNAL = resolve(ROOT, '../personer-familjer/privat/korrigeringar/2026-08-04-externa-fastighetsagare.json');
const DEVICE = 'migration-fastigheter-full-2026-08-02';
const CLOCK_MS = 1785690000000;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const slug = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post';
const unique = values => [...new Set(values.filter(Boolean))];

function parseYearToken(raw) {
  const token = String(raw || '').trim();
  const qualifier = /slutet/i.test(token) ? 'slutet' : /början/i.test(token) ? 'början' : /mitten/i.test(token) ? 'mitten' : null;
  const splitDecades = token.match(/\b(1\d{2})\/(\d)X\b/i);
  if (splitDecades) return { year: null, min: Number(splitDecades[1]) * 10, max: Number(`${splitDecades[1].slice(0, 2)}${splitDecades[2]}`) * 10 + 9, precision: 'decennieintervall', qualifier };
  const decade = token.match(/\b(1\d{2}|20\d)X\b/i);
  if (decade) return { year: null, min: Number(decade[1]) * 10, max: Number(decade[1]) * 10 + 9, precision: 'decennium', qualifier };
  const fullSwedishDecade = token.match(/\b(1\d{3}|20\d{2})-talet\b/i);
  if (fullSwedishDecade) return { year: null, min: Number(fullSwedishDecade[1]), max: Number(fullSwedishDecade[1]) + 9, precision: 'decennium', qualifier };
  const shortSwedishDecade = token.match(/\b(\d{2})-talet\b/i);
  if (shortSwedishDecade) {
    const start = Number(`19${shortSwedishDecade[1]}`);
    return { year: null, min: start, max: start + 9, precision: 'decennium', qualifier };
  }
  const exact = token.match(/\b(1[7-9]\d{2}|20\d{2})\b/);
  if (exact) {
    const year = Number(exact[1]);
    return { year, min: year, max: year, precision: token.includes('?') ? 'ungefärligt år' : 'år' };
  }
  return { year: null, min: null, max: null, precision: token ? 'fritext' : null };
}

function parsePeriod(periodText) {
  if (!periodText) return {};
  const normalized = periodText.replace(/[–—]/g, '-').trim();
  const range = normalized.match(/^(.*?)\s*-\s*(?!talet\b)(.*)$/i);
  if (!range) {
    const start = parseYearToken(normalized);
    if (start.precision === 'fritext') return { period_text: periodText, date_precision: 'fritext' };
    return {
      period_text: periodText,
      start_year: start.year,
      start_year_min: start.min,
      start_year_max: start.max,
      start_precision: start.precision,
      start_qualifier: start.qualifier || null,
    };
  }
  const parts = [range[1], range[2]];
  const start = parseYearToken(parts[0]);
  const end = parseYearToken(parts[1]);
  return {
    period_text: periodText,
    start_year: start.year,
    start_year_min: start.min,
    start_year_max: start.max,
    start_precision: start.precision,
    start_qualifier: start.qualifier || null,
    end_year: end.year,
    end_year_min: end.min,
    end_year_max: end.max,
    end_precision: end.precision,
    ongoing: parts[1].trim() === '',
  };
}

function parseManualText(text) {
  const matches = [...text.matchAll(/\(([^()]*)\)\??/g)];
  const candidate = matches.at(-1);
  const candidateText = candidate?.[1]?.trim() || '';
  const looksLikePeriod = /(?:1[7-9]\d{2}|20\d{2}|1\d{2}X|1\d{2}\/\dX|\d{2}-talet|\?\s*[–-]|[–-]\s*\?|[–-]\s*(?:1[7-9]\d{2}|20\d{2})|(?:1[7-9]\d{2}|20\d{2})\s*[–-])/.test(candidateText);
  const periodText = looksLikePeriod ? candidateText.replace(/^hyrde\s+(?:i|under)\s+/i, '').trim() : null;
  const holderText = periodText ? `${text.slice(0, candidate.index)}${text.slice(candidate.index + candidate[0].length)}`.trim() : text.trim();
  const eventLike = /auktion|förrättning|avstyckning|avsöndring|ägostyckning/i.test(holderText);
  const role = /hyrde|hyresgäst/i.test(text) ? 'hyresgäst'
    : /dödsbo/i.test(holderText) ? 'dödsbo'
      : /samfällda ägor/i.test(holderText) ? 'samfällt ägande'
        : /pensionatrörelse/i.test(holderText) ? 'ägande/verksamhetsdrift'
          : /privat sommarnöje/i.test(holderText) ? 'bruk/fastighetskaraktär'
            : /förening/i.test(holderText) ? 'organisationsägande'
              : 'möjlig ägare eller innehavare';
  const uncertain = /\?|\bX\b|\dX|svårtytt|oklart|möjligen/i.test(text);
  return { holder_text: holderText, period_text: periodText, event_like: eventLike, role, certainty: uncertain ? 'osäker' : 'uppgift i granskad arbetsnot', ...parsePeriod(periodText) };
}

await mkdir(OUT, { recursive: true });
const sourceText = await readFile(SOURCE_PATH, 'utf8');
const source = JSON.parse(sourceText);
const matrikelDocs = await Promise.all([
  ...['initial-ops.json', 'ui-metadata-ops.json', 'approved-excel-ops.json'].map(file => readJson(resolve(MATRIKEL, file))),
  readJson(MATRIKEL_EXTERNAL),
]);
const matrikel = materialize(matrikelDocs.flatMap(document => document.operations));
const people = new Map(matrikel.listEntities('person').map(entity => [entity.entity_id, { id: entity.entity_id, ...entity.fields }]));
const properties = matrikel.listEntities('property').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const propertyIds = new Set(properties.map(property => property.id));
const sourceIds = new Set(source.sources.map(item => item.id));
const historicalUnitIds = new Set(source.historical_units.map(item => item.id));
const eventIds = new Set(source.events.map(item => item.id));

function requireProperty(id, context) {
  if (!propertyIds.has(id)) throw new Error(`Okänd fastighet i ${context}: ${id}`);
}
function requireSource(id, context) {
  if (!sourceIds.has(id)) throw new Error(`Okänd källa i ${context}: ${id}`);
}
function requirePerson(id, context) {
  if (!people.has(id)) throw new Error(`Okänd matrikelperson i ${context}: ${id}`);
}
function sourcesValid(ids, context) {
  for (const id of ids || []) requireSource(id, context);
}

for (const [name, personId] of Object.entries(source.person_links)) requirePerson(personId, `personlänken ${name}`);
for (const relation of source.property_relations) {
  requireProperty(relation.to_property_id, `fastighetsrelationen ${relation.id}`);
  if (relation.from_type === 'property') requireProperty(relation.from_id, `fastighetsrelationen ${relation.id}`);
  else if (!historicalUnitIds.has(relation.from_id)) throw new Error(`Okänd historisk enhet i ${relation.id}: ${relation.from_id}`);
  if (relation.event_id && !eventIds.has(relation.event_id)) throw new Error(`Okänd händelse i ${relation.id}: ${relation.event_id}`);
  sourcesValid(relation.source_ids, relation.id);
}
for (const event of source.events) {
  event.property_ids.forEach(id => requireProperty(id, event.id));
  sourcesValid(event.source_ids, event.id);
}
for (const item of source.event_parties) if (!eventIds.has(item.event_id)) throw new Error(`Okänd händelsepart: ${item.event_id}`);
for (const holding of source.historical_holdings) {
  if (holding.subject_type === 'property') requireProperty(holding.subject_id, 'historiskt innehav');
  else if (!historicalUnitIds.has(holding.subject_id)) throw new Error(`Okänd historisk enhet i innehav: ${holding.subject_id}`);
  sourcesValid(holding.source_ids, `innehav ${holding.name}`);
}
for (const observation of source.ownership_observations) {
  requireProperty(observation.property_id, 'ägarobservation');
  requireSource(observation.source_id, 'ägarobservation');
}
const currentOwnerProperties = new Set();
for (const assessment of source.current_owner_assessments || []) {
  requireProperty(assessment.property_id, 'bedömning av nuvarande ägare');
  sourcesValid(assessment.source_ids, `bedömning av nuvarande ägare ${assessment.property_id}`);
  if (!assessment.owners?.length) throw new Error(`Bedömningen saknar ägare: ${assessment.property_id}`);
  for (const owner of assessment.owners) if (!source.party_display_surnames?.[owner]) throw new Error(`Visningsefternamn saknas för nuvarande ägare ${owner} på ${assessment.property_id}`);
  if (currentOwnerProperties.has(assessment.property_id)) throw new Error(`Flera nulägesbedömningar för ${assessment.property_id}`);
  currentOwnerProperties.add(assessment.property_id);
}
for (const chain of source.manual_chains) requireProperty(chain.property_id, 'manuell ägarkedja');
for (const event of source.manual_event_claims || []) {
  event.property_ids.forEach(id => requireProperty(id, `manuellt händelseanspråk ${event.id}`));
  sourcesValid(event.source_ids, `manuellt händelseanspråk ${event.id}`);
}
for (const support of source.manual_support || []) {
  requireProperty(support.property_id, 'manuellt källstöd');
  sourcesValid(support.source_ids, `manuellt källstöd ${support.property_id}`);
}
for (const rejected of source.rejected_claims || []) {
  requireProperty(rejected.property_id, 'avfört ägaranspråk');
  sourcesValid(rejected.source_ids, `avfört ägaranspråk ${rejected.id}`);
}
for (const finding of source.audit_findings) requireProperty(finding.property_id, 'källgranskning');
const manualIds = new Set(source.manual_chains.map(item => item.property_id));
const auditIds = new Set(source.audit_findings.map(item => item.property_id));
if (manualIds.size !== source.manual_chains.length) throw new Error('En fastighet förekommer flera gånger i den manuella ägartabellen');
for (const id of manualIds) if (!auditIds.has(id)) throw new Error(`Källgranskning saknas för ${id}`);

const records = {
  source: source.sources.map(item => ({ id: item.id, ...item })),
  property: properties.map(property => ({ ...property, canonical_master: 'fastigheter', imported_from: 'Matrikeln 2026-08-01' })),
  'historical-unit': source.historical_units.map(item => ({ id: item.id, ...item })),
  'property-relation': source.property_relations.map(item => ({ id: item.id, ...item })),
  event: source.events.map(item => ({ id: item.id, ...item })),
  party: [],
  'event-party': [],
  holding: [],
  observation: [],
  'current-owner-assessment': [],
  'manual-claim': [],
  'holding-claim': [],
  'event-claim': [],
  'audit-finding': [],
  'rejected-claim': [],
  'community-link': [],
  evidence: [],
};

const parties = new Map();
function partyFor(name) {
  const baseId = `party-${slug(name)}`;
  const baseExisting = parties.get(baseId);
  const id = baseExisting && baseExisting.name !== name ? `${baseId}-${sha256(name).slice(0, 8)}` : baseId;
  const existing = parties.get(id);
  if (existing && existing.name !== name) throw new Error(`Part-id kolliderar även efter kontrollsumma: ${existing.name} / ${name}`);
  if (!existing) {
    const personId = source.person_links[name] || null;
    const displaySurname = source.party_display_surnames?.[name] || null;
    parties.set(id, {
      id,
      name,
      party_type: /förening/i.test(name) ? 'organisation' : /dödsbo|arvingar/i.test(name) ? 'kollektiv' : 'person eller namngrupp',
      person_id: personId,
      ...(displaySurname ? { display_surname: displaySurname } : {}),
      identity_status: personId ? 'kopplad till Matrikeln' : 'fristående part',
    });
  }
  return id;
}

source.event_parties.forEach((item, index) => {
  const partyId = partyFor(item.name);
  records['event-party'].push({ id: `${item.event_id}--${slug(item.role)}--${String(index + 1).padStart(2, '0')}`, ...item, party_id: partyId });
});
source.historical_holdings.forEach((item, index) => {
  const partyId = partyFor(item.name);
  records.holding.push({ id: `holding-historical-${String(index + 1).padStart(3, '0')}`, ...item, party_id: partyId, basis: 'historiskt belägg' });
});
for (const observation of source.ownership_observations) {
  const ownerPartyIds = observation.owners.map(partyFor);
  const observationId = `observation-${slug(observation.property_id)}-${observation.observed_on}`;
  records.observation.push({ id: observationId, ...observation, owner_party_ids: ownerPartyIds });
  observation.owners.forEach((name, index) => {
    records.holding.push({
      id: `holding-${slug(observation.property_id)}-${observation.observed_on}-${String(index + 1).padStart(2, '0')}`,
      subject_type: 'property', subject_id: observation.property_id, party_id: ownerPartyIds[index], name,
      role: 'lagfaren ägare', observed_on: observation.observed_on, source_ids: [observation.source_id],
      certainty: 'säker vid observationen', basis: 'registerobservation',
      notes: 'Observationen fastställer inte förvärvsdatum.',
    });
  });
}
for (const assessment of source.current_owner_assessments || []) {
  records['current-owner-assessment'].push({
    id: `current-owner-${slug(assessment.property_id)}`,
    ...assessment,
    owner_party_ids: assessment.owners.map(partyFor),
  });
}
function supportFor(propertyId, text) {
  return (source.manual_support || []).filter(item => item.property_id === propertyId
    && (item.text ? item.text === text : item.contains ? text.includes(item.contains) : true));
}

for (const chain of source.manual_chains) {
  const normalizedItems = [];
  chain.entries.forEach((text, index) => {
    const manualId = `manual-${slug(chain.property_id)}-${String(index + 1).padStart(2, '0')}`;
    const supports = supportFor(chain.property_id, text);
    const parsed = parseManualText(text);
    const roleOverride = supports.find(item => item.role)?.role;
    if (roleOverride) parsed.role = roleOverride;
    const sourceIdsForClaim = unique(['NOT-INTFAKTA', ...supports.flatMap(item => item.source_ids || [])]);
    const verificationStatus = supports.some(item => item.verification_status === 'primärbelagd') ? 'primärbelagd'
      : supports.some(item => item.verification_status === 'förstahandsbelagd') ? 'förstahandsbelagd'
        : supports.some(item => item.verification_status === 'sekundärbelagd') ? 'sekundärbelagd'
        : parsed.certainty === 'osäker' ? 'osäker uppgift i arbetsnot' : 'uppgift i granskad arbetsnot';
    if (!roleOverride && /belagd/.test(verificationStatus) && parsed.role === 'möjlig ägare eller innehavare') parsed.role = 'ägare';
    let normalizedEntityType;
    let normalizedEntityId;
    if (parsed.event_like) {
      normalizedEntityType = 'event-claim';
      normalizedEntityId = `event-claim-${slug(chain.property_id)}-${String(index + 1).padStart(2, '0')}`;
      records['event-claim'].push({
        id: normalizedEntityId,
        property_ids: [chain.property_id],
        type: /auktion/i.test(text) ? 'exekutiv auktion' : 'historisk händelse',
        label: parsed.holder_text,
        ...parsePeriod(parsed.period_text),
        date_text: parsed.period_text,
        certainty: parsed.certainty,
        verification_status: verificationStatus,
        source_ids: sourceIdsForClaim,
        source_locators: supports.map(item => item.locator).filter(Boolean),
        evidence_notes: supports.map(item => item.note).filter(Boolean),
        manual_claim_id: manualId,
        raw_text: text,
        origin: 'råkedja',
      });
    } else {
      normalizedEntityType = 'holding-claim';
      normalizedEntityId = `holding-claim-${slug(chain.property_id)}-${String(index + 1).padStart(2, '0')}`;
      const partyId = partyFor(parsed.holder_text);
      records['holding-claim'].push({
        id: normalizedEntityId,
        property_id: chain.property_id,
        party_id: partyId,
        holder_text: parsed.holder_text,
        role: parsed.role,
        ...parsePeriod(parsed.period_text),
        certainty: parsed.certainty,
        verification_status: verificationStatus,
        source_ids: sourceIdsForClaim,
        source_locators: supports.map(item => item.locator).filter(Boolean),
        evidence_notes: supports.map(item => item.note).filter(Boolean),
        manual_claim_id: manualId,
        raw_text: text,
        order: index + 1,
      });
    }
    records['manual-claim'].push({
      id: manualId,
      property_id: chain.property_id,
      order: index + 1,
      text,
      role: parsed.role,
      source_ids: sourceIdsForClaim,
      normalized: true,
      normalized_entity_type: normalizedEntityType,
      normalized_entity_id: normalizedEntityId,
    });
    normalizedItems.push({ type: normalizedEntityType, id: normalizedEntityId, parsed, source_ids: sourceIdsForClaim, text });
  });
  for (let index = 1; index < normalizedItems.length; index += 1) {
    const before = normalizedItems[index - 1];
    const after = normalizedItems[index];
    if (before.type !== 'holding-claim' || after.type !== 'holding-claim') continue;
    const date = after.parsed.start_year || after.parsed.start_year_min || before.parsed.end_year || before.parsed.end_year_max || null;
    records['event-claim'].push({
      id: `transition-claim-${slug(chain.property_id)}-${String(index).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
      property_ids: [chain.property_id],
      type: before.parsed.role === 'hyresgäst' || after.parsed.role === 'hyresgäst' ? 'möjligt rollskifte' : 'möjligt kedjeskifte',
      label: `${before.parsed.holder_text} → ${after.parsed.holder_text}`,
      date_text: date ? String(date) : after.parsed.period_text || (before.parsed.end_year || before.parsed.end_year_min ? before.parsed.period_text : null) || 'odaterat',
      year_min: after.parsed.start_year_min || before.parsed.end_year_min || null,
      year_max: after.parsed.start_year_max || before.parsed.end_year_max || null,
      certainty: 'härledd ur kedjeordning',
      verification_status: 'tolkning av råkedjans ordningsföljd',
      source_ids: unique([...before.source_ids, ...after.source_ids]),
      from_claim_id: before.id,
      to_claim_id: after.id,
      origin: 'härledd övergång',
    });
  }
}

for (const item of source.manual_event_claims || []) records['event-claim'].push({
  ...item,
  origin: item.origin || 'manuella tabellens förrättnings-/priskolumn',
});

records.party = [...parties.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));

function propertySourceIds(propertyId) {
  const ids = new Set(['NOT-INTFAKTA']);
  source.events.filter(item => item.property_ids.includes(propertyId)).flatMap(item => item.source_ids).forEach(id => ids.add(id));
  source.ownership_observations.filter(item => item.property_id === propertyId).forEach(item => ids.add(item.source_id));
  (source.current_owner_assessments || []).filter(item => item.property_id === propertyId).flatMap(item => item.source_ids || []).forEach(id => ids.add(id));
  source.property_relations.filter(item => item.to_property_id === propertyId || item.from_id === propertyId).flatMap(item => item.source_ids).forEach(id => ids.add(id));
  (source.manual_support || []).filter(item => item.property_id === propertyId).flatMap(item => item.source_ids || []).forEach(id => ids.add(id));
  (source.manual_event_claims || []).filter(item => item.property_ids.includes(propertyId)).flatMap(item => item.source_ids || []).forEach(id => ids.add(id));
  (source.rejected_claims || []).filter(item => item.property_id === propertyId).flatMap(item => item.source_ids || []).forEach(id => ids.add(id));
  return [...ids];
}
records['audit-finding'] = source.audit_findings.map((item, index) => ({
  id: `audit-${slug(item.property_id)}`, ...item, order: index + 1, compared_source_ids: propertySourceIds(item.property_id), reviewed_on: '2026-08-02',
}));
records['rejected-claim'] = (source.rejected_claims || []).map(item => ({ ...item }));

const matrikelPropertyLinks = matrikel.listEntities('property-link');
for (const entity of matrikelPropertyLinks) {
  const link = entity.fields;
  requireProperty(link.property_id, entity.entity_id);
  requirePerson(link.person_id, entity.entity_id);
  records['community-link'].push({
    id: entity.entity_id.replace(/^property-link:/, 'community-link:'),
    property_id: link.property_id,
    person_id: link.person_id,
    person_display_name: people.get(link.person_id).display_name,
    relation: 'fastighetsgemenskap',
    legal_ownership: false,
    confirmed: link.confirmed === true,
    source: link.source || 'Simons godkända Excelgranskning 2026-08-01',
  });
}

function addEvidence(subjectType, subjectId, sourceId, locator = null, stance = 'stöd') {
  requireSource(sourceId, `evidens ${subjectType}:${subjectId}`);
  const id = `evidence-${slug(subjectType)}-${slug(subjectId)}-${slug(sourceId)}`;
  if (records.evidence.some(item => item.id === id)) return;
  records.evidence.push({ id, subject_type: subjectType, subject_id: subjectId, source_id: sourceId, locator, stance });
}
for (const event of records.event) for (const sourceId of event.source_ids) addEvidence('event', event.id, sourceId);
for (const holding of records.holding) for (const sourceId of holding.source_ids) addEvidence('holding', holding.id, sourceId);
for (const assessment of records['current-owner-assessment']) for (const sourceId of assessment.source_ids) addEvidence('current-owner-assessment', assessment.id, sourceId, null, 'bäst kända nuläge');
for (const holding of records['holding-claim']) for (const sourceId of holding.source_ids) addEvidence('holding-claim', holding.id, sourceId, holding.source_locators?.join('; ') || null, holding.verification_status.includes('belagd') ? 'stöd' : 'anspråk');
for (const event of records['event-claim']) for (const sourceId of event.source_ids) addEvidence('event-claim', event.id, sourceId, event.source_locators?.join('; ') || null, event.verification_status?.includes('belagd') ? 'stöd' : 'anspråk');
for (const relation of records['property-relation']) for (const sourceId of relation.source_ids) addEvidence('property-relation', relation.id, sourceId);
for (const finding of records['audit-finding']) for (const sourceId of finding.compared_source_ids) addEvidence('audit-finding', finding.id, sourceId);
for (const rejected of records['rejected-claim']) for (const sourceId of rejected.source_ids) addEvidence('rejected-claim', rejected.id, sourceId, null, 'motsäger');

let seq = 0;
const operations = [];
function set(entityType, entityId, field, value) {
  seq += 1;
  operations.push({
    op_id: `${DEVICE}:${seq}`, device_id: DEVICE, seq, entity_type: entityType, entity_id: entityId,
    field, value, hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`, schema_version: 1,
  });
}
set('root', 'fastigheter', 'schema_version', source.schema_version);
set('root', 'fastigheter', 'migration_id', '2026-08-02-fastighetshistorik-full');
set('root', 'fastigheter', 'source_sha256', sha256(sourceText));
set('root', 'fastigheter', 'date_roles', source.principles.date_roles);
set('root', 'fastigheter', 'owner_observation_principle', source.principles.owner_observation);
set('root', 'fastigheter', 'current_owner_principle', source.principles.current_owner);
for (const [entityType, items] of Object.entries(records)) for (const item of items) {
  const { id, ...fields } = item;
  for (const [field, value] of Object.entries(fields)) set(entityType, id, field, value);
}

const counts = Object.fromEntries(Object.entries(records).map(([key, items]) => [key.replaceAll('-', '_'), items.length]));
const document = {
  operations_version: 1,
  dataset: source.dataset,
  device_id: DEVICE,
  migration_id: '2026-08-02-fastighetshistorik-full',
  counts,
  operations,
};
const researchExport = {
  export_version: 1,
  dataset: source.dataset,
  generated_on: new Date().toISOString(),
  source_sha256: sha256(sourceText),
  counts,
  tables: records,
};
const important = records['audit-finding'].filter(item => item.severity === 'viktig');
const sourceById = new Map(records.source.map(item => [item.id, item]));
const md = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();
const sourceNames = ids => unique(ids || []).map(id => sourceById.get(id)?.label || id).join('; ') || 'inget fristående belägg';
const claimPeriod = item => item.period_text || item.date_text || item.contract_date || item.possession_date || item.survey_date || item.survey_date_text || item.approval_date || item.approval_date_text || item.application_date || item.observed_on || 'odaterat';
const claimStatus = item => item.verification_status || (item.report_kind === 'belagd händelse' ? 'källbelagd' : item.certainty || 'ej bedömd');
const claimSources = item => {
  const names = sourceNames(item.source_ids || (item.source_id ? [item.source_id] : []));
  const locators = (item.source_locators || []).filter(Boolean).join('; ');
  return locators ? `${names} — ${locators}` : names;
};
const independentlySupported = records['holding-claim'].filter(item => /belagd/.test(item.verification_status));
const workingClaims = records['holding-claim'].filter(item => !/belagd/.test(item.verification_status));
const derivedTransitions = records['event-claim'].filter(item => item.origin === 'härledd övergång');
const propertiesSorted = [...records.property].sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true }));
const sourceCatalog = records.source.map(item => `| ${item.id} | ${md(item.label)} | ${md(item.type)} | \`${md(item.path)}\` |`).join('\n');
const fullPropertyAudit = propertiesSorted.map(property => {
  const propertyId = property.id;
  const finding = records['audit-finding'].find(item => item.property_id === propertyId);
  const current = records['current-owner-assessment'].find(item => item.property_id === propertyId);
  const claims = records['holding-claim'].filter(item => item.property_id === propertyId).sort((a, b) => (a.order || 0) - (b.order || 0));
  const propertyEvents = [
    ...records.event.filter(item => item.property_ids.includes(propertyId)).map(item => ({ ...item, report_kind: 'belagd händelse' })),
    ...records['event-claim'].filter(item => item.property_ids.includes(propertyId) && item.origin !== 'härledd övergång' && !item.superseded_by_event_id)
      .map(item => ({ ...item, report_kind: 'händelseanspråk' })),
  ].sort((a, b) => Number(String(claimPeriod(a)).match(/\b(1[7-9]\d{2}|20\d{2})\b/)?.[1] || 9999) - Number(String(claimPeriod(b)).match(/\b(1[7-9]\d{2}|20\d{2})\b/)?.[1] || 9999));
  const relations = records['property-relation'].filter(item => item.to_property_id === propertyId || item.from_id === propertyId);
  const rejected = records['rejected-claim'].filter(item => item.property_id === propertyId);
  const community = records['community-link'].filter(item => item.property_id === propertyId);
  const currentText = current
    ? `**Bäst kända nuvarande ägare:** ${current.owners.join(', ')}. Belägg: ${sourceNames(current.source_ids)}. ${current.basis}`
    : '**Bäst kända nuvarande ägare:** saknas.';
  const claimLines = claims.length ? claims.map(item => {
    const notes = [...(item.evidence_notes || []), /belagd/.test(item.verification_status) ? null : item.certainty].filter(Boolean).join(' ');
    return `- **${md(claimPeriod(item))} — ${md(item.holder_text)}** · ${md(item.role)} · _${md(claimStatus(item))}_\n  - Belägg: ${md(claimSources(item))}${notes ? `\n  - Anmärkning: ${md(notes)}` : ''}`;
  }).join('\n') : '- Ingen historisk innehavskedja är införd.';
  const eventLines = propertyEvents.length ? propertyEvents.map(item =>
    `- **${md(claimPeriod(item))} — ${md(item.label)}** · ${md(item.report_kind)} · _${md(claimStatus(item))}_\n  - Belägg: ${md(claimSources(item))}${item.notes ? `\n  - Anmärkning: ${md(item.notes)}` : ''}`
  ).join('\n') : '- Inga fristående händelser är införda.';
  const relationLines = relations.length ? relations.map(item =>
    `- ${md(item.from_id)} → ${md(item.to_property_id)} · ${md(item.relation)} · Belägg: ${md(sourceNames(item.source_ids))}${item.notes ? ` · ${md(item.notes)}` : ''}`
  ).join('\n') : '- Inga strukturerade fastighetsrelationer är införda.';
  const rejectedLines = rejected.length ? rejected.map(item =>
    `- ~~${md(item.claim)}~~ — ${md(item.reason)} Belägg för avförandet: ${md(sourceNames(item.source_ids))}${item.locator ? ` — ${md(item.locator)}` : ''}.`
  ).join('\n') : '- Inga uttryckligen avförda ägaranspråk.';
  const communityNames = community.map(item => item.person_display_name).filter(Boolean);
  return `## ${propertyId}\n\n${currentText}\n\n` +
    `**Granskningsbedömning:** ${finding ? `${finding.status}. ${finding.summary}` : 'ingen särskild bedömning registrerad.'}\n\n` +
    `### Innehav och bruk i källornas kedjeordning\n\n${claimLines}\n\n` +
    `### Händelser\n\n${eventLines}\n\n` +
    `### Fastighetsrelationer\n\n${relationLines}\n\n` +
    `### Avförda slutsatser\n\n${rejectedLines}\n\n` +
    `### Fastighetsgemenskap i Matrikeln\n\n${communityNames.length ? communityNames.join(', ') : 'Ingen koppling registrerad.'}\n\n` +
    `_Fastighetsgemenskap är en nutida person–fastighetskoppling i Matrikeln, inte i sig bevis för lagfart eller historiskt boende._`;
}).join('\n\n---\n\n');
const auditReport = `# Fullständig källkontroll — Fastigheter\n\n` +
  `Skapad 2026-08-04 direkt från den privata Fastigheter-mastern efter kontroll mot lantmäteriakter, fastighetsregister, intervjuer, minnesberättelser och tryckt material. ` +
  `Rapporten är ett granskningsunderlag, inte ett påstående om att alla luckor är lösta. FAST-1/FAST-2 är ögonblicksbilder av ägare och får inte automatiskt användas som förvärvsdatum.\n\n` +
  `## Läsregler\n\n` +
  `- **Primärbelagd:** direkt lantmäteri-/registerhandling eller annan primär dokumentation.\n` +
  `- **Förstahandsbelagd:** namngiven persons egen berättelse om sitt eller familjens förhållande.\n` +
  `- **Sekundärbelagd:** tryckt framställning eller annan återberättande källa.\n` +
  `- **Arbetsnot/osäker:** uppgiften är bevarad för granskning men saknar ännu självständigt belägg.\n` +
  `- Härledda övergångar mellan två rader räknas inte som självständiga fakta och listas därför inte bland händelserna nedan.\n\n` +
  `## Sammanfattning\n\n` +
  `- ${records.property.length} fastighetsobjekt\n` +
  `- ${records['audit-finding'].length} fastigheter med särskild granskningsbedömning\n` +
  `- ${important.length} viktiga rättelser eller olösta frågor\n` +
  `- ${records['holding-claim'].length} strukturerade innehavs-/bruksposter ur råkedjorna\n` +
  `- ${independentlySupported.length} poster med fristående primär-, förstahands- eller sekundärbelägg\n` +
  `- ${workingClaims.length} poster som ännu bara är arbetsuppgifter eller uttryckligen osäkra\n` +
  `- ${records['rejected-claim'].length} felaktiga slutsatser uttryckligen avförda\n` +
  `- ${derivedTransitions.length} tekniskt härledda kedjeövergångar, inte redovisade som fakta\n\n` +
  `## Viktig proveniensrättelse\n\n` +
  `Transkriptionsfilen i mappen ”Bok Hans Lundin” innehåller från rad 1264 ett avsnitt som uttryckligen är markerat som troligen ur Lena Bövings bok. ` +
  `Uppgifter från sidorna 69–73 hänförs därför till **Fotograferat bokutdrag, troligen Lena Böving**, inte till Hans Lundin.\n\n` +
  `## Källkatalog\n\n| ID | Källa | Typ | Sökväg |\n|---|---|---|---|\n${sourceCatalog}\n\n` +
  `## Fastighet för fastighet\n\n${fullPropertyAudit}\n`;

await Promise.all([
  writeFile(resolve(OUT, 'initial-ops.json'), JSON.stringify(document, null, 2)),
  writeFile(resolve(OUT, 'research-export.json'), JSON.stringify(researchExport, null, 2)),
  writeFile(resolve(OUT, 'kallgranskning.md'), auditReport),
  writeFile(resolve(OUT, 'manifest.json'), JSON.stringify({ migration_id: document.migration_id, source_sha256: sha256(sourceText), counts, principles: source.principles }, null, 2)),
]);
console.log(JSON.stringify({ operations: operations.length, ...counts }, null, 2));
