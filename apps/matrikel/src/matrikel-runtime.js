import { ActiveJsonMaster } from '../../../packages/core/active-json-master.js';
import { assertCompatibleActiveDependency } from '../../../packages/core/dependency-compatibility.js';
import { assertWriterDomainFields } from '../../../packages/master-data-v2/index.js';
import { createMatrikelCanaryRepository, createMatrikelPersonReadOnlyMaster } from './matrikel-canary.js';

const SOURCE_LAYOUT_CACHE_VERSION = 1;
const SOURCE_LAYOUT_CACHE_KEY = 'active-json-master:matrikel-source-layout:snapshot';
const SHA256_RE = /^[a-f0-9]{64}$/;

const clone = value => value == null ? value : structuredClone(value);
const pointerDirectory = path => path.slice(0, path.lastIndexOf('/')) || '/';

function resolveRelativePath(pointerPath, relativePath) {
  const relative = String(relativePath || '');
  if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('\\')) {
    throw new TypeError('Matrikelns källarkiv har en ogiltig relativ sökväg');
  }
  return `${pointerDirectory(pointerPath)}/${relative}`.replace(/\/+/g, '/');
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${label} innehåller ogiltig JSON`); }
}

function requireRecordList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} måste vara en lista`);
  const ids = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id) {
      throw new TypeError(`${label} innehåller en post utan id`);
    }
    if (ids.has(row.id)) throw new TypeError(`${label} innehåller dubblerat id: ${row.id}`);
    ids.add(row.id);
  }
  return value;
}

function compactSourceLayout(sourceMaster, sourceMasterSha256) {
  if (!sourceMaster || sourceMaster.app !== 'matrikel' || !sourceMaster.data) {
    throw new TypeError('Matrikelns källarkiv har fel format');
  }
  const allRows = requireRecordList(sourceMaster.data.source_rows, 'Källarkivets source_rows');
  const layouts = requireRecordList(sourceMaster.data.source_layout_rows, 'Källarkivets source_layout_rows')
    .filter(row => !row.deleted_at && row.retained !== false && row.lifecycle_status !== 'archived_variant');
  const rowById = new Map(allRows.map(row => [row.id, row]));
  const referencedIds = new Set(layouts.flatMap(row => [row.member_source_row_id, ...(row.boat_source_row_ids || [])].filter(Boolean)));
  const missingIds = [...referencedIds].filter(id => !rowById.has(id));
  if (missingIds.length) throw new Error(`Källayouten pekar på ${missingIds.length} saknade källrader`);
  return {
    cache_version: SOURCE_LAYOUT_CACHE_VERSION,
    source_master_sha256: sourceMasterSha256,
    source_master_revision: sourceMaster.master_revision,
    source_rows: [...referencedIds].map(id => clone(rowById.get(id))),
    source_layout_rows: layouts.map(clone),
  };
}

function validateCachedSourceLayout(value) {
  if (!value || value.cache_version !== SOURCE_LAYOUT_CACHE_VERSION || !SHA256_RE.test(String(value.source_master_sha256 || ''))) return null;
  requireRecordList(value.source_rows, 'Cachens source_rows');
  requireRecordList(value.source_layout_rows, 'Cachens source_layout_rows');
  return clone(value);
}

class MatrikelSourceLayoutArchive {
  constructor({ store } = {}) {
    this.store = store;
    this.state = null;
  }

  async init() {
    const cached = await this.store.getSnapshot(SOURCE_LAYOUT_CACHE_KEY);
    this.state = cached ? validateCachedSourceLayout(cached) : null;
    return this;
  }

  get data() { return this.state ? clone(this.state) : null; }
  get rowCount() { return this.state?.source_rows.length || 0; }
  get layoutRowCount() { return this.state?.source_layout_rows.length || 0; }

  async descriptor(transport, pointer) {
    if (pointer?.source_layout_archive) return pointer.source_layout_archive;
    if (!pointer?.manifest_relative_path) return null;
    const manifestPath = resolveRelativePath('/matrikel-generation2/active.json', pointer.manifest_relative_path);
    const manifest = parseJsonBytes(await transport.getBytes(manifestPath), 'Matrikelmanifestet');
    return manifest?.source_archive || null;
  }

  async sync(transport, pointer) {
    if (typeof transport?.getBytes !== 'function') throw new TypeError('Källarkivet kräver en byte-lästransport');
    const descriptor = await this.descriptor(transport, pointer);
    if (!descriptor) return { available: Boolean(this.state), changed: false };
    const sha256 = String(descriptor.master_sha256 || descriptor.sha256 || '');
    const relativePath = descriptor.master_relative_path || descriptor.relative_path;
    if (!SHA256_RE.test(sha256)) throw new TypeError('Matrikelmanifestet saknar källarkivets SHA-256');
    if (this.state?.source_master_sha256 === sha256) return { available: true, changed: false };
    const sourcePath = resolveRelativePath('/matrikel-generation2/active.json', relativePath);
    const bytes = await transport.getBytes(sourcePath);
    const actualHash = await crypto.subtle.digest('SHA-256', bytes);
    const actualSha256 = [...new Uint8Array(actualHash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actualSha256 !== sha256) throw new Error('Matrikelns källarkiv har fel SHA-256');
    const compact = compactSourceLayout(parseJsonBytes(bytes, 'Matrikelns källarkiv'), sha256);
    await this.store.saveSnapshot(SOURCE_LAYOUT_CACHE_KEY, compact);
    this.state = compact;
    return { available: true, changed: true };
  }
}

const REQUIRED_MATRIKEL_COLLECTIONS = Object.freeze([
  'memberships',
  'releases',
  'person_occurrences',
  'boat_occurrences',
  'organizations',
  'roles',
  'role_terms',
  'awards',
  'award_events',
]);

function personReferences(master) {
  const memberships = new Map(master.matrikel.data.memberships
    .filter(row => !row.deleted_at)
    .map(row => [row.person_ref?.entity_id, row]));
  return master.people.data.people.filter(row => !row.deleted_at).map(row => {
    const membership = memberships.get(row.id);
    return {
      id: `person-ref:${row.id}`,
      external_id: row.id,
      display_name: row.display_name,
      club_name: membership?.club_name || null,
      url: `../personer-familjer/?person=${encodeURIComponent(row.id)}`,
      match_status: 'kopplad',
    };
  });
}

function boatReferences(master) {
  return master.boats.data.boats.filter(row => !row.deleted_at).map(row => ({
    id: `boat-ref:${row.id}`,
    external_id: row.id,
    name: row.display_name,
    display_name: row.display_name,
    category: row.category || null,
    model: row.model || null,
    events: row.events || [],
    url: `../batregister/?boat=${encodeURIComponent(row.id)}`,
    match_status: 'kopplad',
  }));
}

function assertDependencies(matrikelPointer, peoplePointer) {
  assertCompatibleActiveDependency(peoplePointer, {
    master_revision: matrikelPointer.person_master_revision,
    master_sha256: matrikelPointer.person_master_sha256,
  }, 'Matrikelns Personberoende');
}

export class MatrikelActiveRuntime {
  constructor({ store } = {}) {
    this.matrikel = new ActiveJsonMaster({
      store,
      cacheKey: 'matrikel-generation2-primary',
      pointerPath: '/matrikel-generation2/active.json',
      app: 'matrikel',
      requiredCollections: REQUIRED_MATRIKEL_COLLECTIONS,
    });
    this.people = new ActiveJsonMaster({
      store,
      cacheKey: 'people-for-matrikel-generation2',
      pointerPath: '/personer-familjer/active.json',
      app: 'people',
      requiredCollections: ['people'],
    });
    this.boats = new ActiveJsonMaster({
      store,
      cacheKey: 'boats-for-matrikel-generation2',
      pointerPath: '/batregister-generation2/active.json',
      app: 'batregister',
      requiredCollections: ['boats'],
    });
    this.sourceLayout = new MatrikelSourceLayoutArchive({ store });
    this.repository = null;
    this.personMaster = null;
    this.bundle = null;
  }

  async init() {
    await Promise.all([this.matrikel.init(), this.people.init(), this.boats.init(), this.sourceLayout.init()]);
    if (this.hasData()) this.rebuild();
    return this;
  }

  hasData() {
    return this.matrikel.hasData() && this.people.hasData() && this.boats.hasData();
  }

  rebuild() {
    if (!this.hasData()) throw new Error('Den aktiva Matrikelns beroenden saknas');
    assertDependencies(this.matrikel.pointer, this.people.pointer);
    assertWriterDomainFields(this.matrikel.master, { allowMissingCollections: false });
    const writerMaster = this.matrikel.master;
    const sourceLayout = this.sourceLayout.data;
    const matrikel = sourceLayout ? {
      ...writerMaster,
      data: {
        ...writerMaster.data,
        source_rows: sourceLayout.source_rows,
        source_layout_rows: sourceLayout.source_layout_rows,
      },
    } : writerMaster;
    const documents = { matrikel, people: this.people.master, boats: this.boats.master };
    const bundle = {
      manifest: { status: 'active_private_master', writer_enabled: this.matrikel.pointer.writer_enabled },
      master: documents.matrikel,
      masterSha256: this.matrikel.pointer.master_sha256,
      personMaster: documents.people,
      personPointer: this.people.pointer,
      personMasterSha256: this.people.pointer.master_sha256,
      retiredReferences: {
        person_refs: personReferences(documents),
        boat_refs: boatReferences(documents),
        club_history_roots: [],
      },
      lifeSyncReport: { schema_version: 1, issues: [], decisions: [] },
      sourceLayoutArchive: sourceLayout ? {
        sourceMasterRevision: sourceLayout.source_master_revision,
        sourceMasterSha256: sourceLayout.source_master_sha256,
        sourceRows: sourceLayout.source_rows.length,
        sourceLayoutRows: sourceLayout.source_layout_rows.length,
      } : null,
    };
    this.bundle = bundle;
    this.repository = createMatrikelCanaryRepository(bundle);
    this.personMaster = createMatrikelPersonReadOnlyMaster(bundle);
    return this;
  }

  async sync(transport) {
    await Promise.all([
      this.matrikel.sync(transport),
      this.people.sync(transport),
      this.boats.sync(transport),
    ]);
    await this.sourceLayout.sync(transport, this.matrikel.pointer);
    this.rebuild();
    return {
      matrikelRevision: this.matrikel.masterRevision,
      peopleRevision: this.people.masterRevision,
      boatRevision: this.boats.masterRevision,
      writable: this.matrikel.pointer.writer_enabled === true,
      sourceRows: this.sourceLayout.rowCount,
      sourceLayoutRows: this.sourceLayout.layoutRowCount,
    };
  }
}

export function createMatrikelActiveRuntime(options) {
  return new MatrikelActiveRuntime(options);
}
