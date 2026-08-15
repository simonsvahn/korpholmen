import { PeopleMembershipMaster } from '../../../packages/core/people-membership-master.js';

const entityRows = (master, type) => master.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));

export class PeopleV2Runtime {
  constructor({ store } = {}) {
    this.master = new PeopleMembershipMaster({ store, cacheKey: 'personer-familjer-active-v2' });
  }

  async init() {
    await this.master.init();
    return this;
  }

  hasData() { return this.master.listEntities('person').length > 0; }

  async sync(transport) { return this.master.sync(transport); }

  listPeople() {
    return entityRows(this.master, 'person')
      .sort((left, right) => left.display_name.localeCompare(right.display_name, 'sv', { numeric: true }));
  }

  getPerson(id) { return this.listPeople().find(person => person.id === id) || null; }

  listRelations() { return entityRows(this.master, 'relation'); }

  relationsFor(personId) {
    return this.listRelations().filter(relation => relation.from_person_id === personId || relation.to_person_id === personId);
  }

  relatedPerson(relation, personId) {
    return this.getPerson(relation.from_person_id === personId ? relation.to_person_id : relation.from_person_id);
  }

  relationLabel(relation, personId) {
    if (relation.relation_type === 'foralder-barn') return relation.from_person_id === personId ? 'Barn' : 'Förälder';
    if (relation.relation_type === 'partner') return 'Partner';
    if (relation.relation_type === 'tidigare') return 'Tidigare partner';
    if (relation.relation_type === 'syskon') return 'Syskon';
    return relation.relation_type || 'Relation';
  }
}

export const createPeopleV2Runtime = options => new PeopleV2Runtime(options);
