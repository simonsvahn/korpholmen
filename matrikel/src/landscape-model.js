export const normalizeText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('sv')
  .replace(/[^a-z0-9åäö]+/g, ' ')
  .trim();

export function shownName(person, clubFirst = false) {
  if (!person) return 'Okänd person';
  const club = person.club_name || person.ui_constructed_club_name;
  return clubFirst && club ? club : person.display_name || person.full_name || 'Okänd person';
}

export function clanBase(name) {
  const text = String(name || 'Utan känd släktkoppling');
  const match = text.match(/^(.+?-klanen)\s+\(/);
  return match ? match[1] : text;
}

export function clanDetail(name) {
  const text = String(name || 'Utan känd släktkoppling');
  const match = text.match(/-klanen\s+\((.+)\)$/);
  return match ? match[1] : text;
}

export function familyHue(name) {
  let value = 0;
  for (const character of String(name || '')) value = (value * 31 + character.charCodeAt(0)) % 360;
  return value;
}

export function generationFor(person) {
  if (Number.isInteger(person.ui_generation)) return person.ui_generation;
  const birth = Number(person.birth);
  if (!Number.isFinite(birth)) return null;
  if (birth <= 1940) return 1;
  if (birth <= 1952) return 2;
  if (birth <= 1978) return 3;
  if (birth <= 2005) return 4;
  return 5;
}

export function personPropertyIds(person) {
  return Array.isArray(person?.property_ids) ? person.property_ids.filter(Boolean) : [];
}

export function resolvedIslands(person) {
  const fromProperties = Array.isArray(person?.property_islands) ? person.property_islands.filter(Boolean) : [];
  return [...new Set([...fromProperties, person?.legacy_island].filter(Boolean))];
}

export function membership(person) {
  const status = person?.membership_status || 'ej';
  if (status === 'aktuell') return { symbol: '●', label: 'Aktuell medlem', className: '' };
  if (status === 'tidigare') return { symbol: '○', label: 'Tidigare medlem', className: 'previous' };
  if (status === 'förväntad') return { symbol: '◐', label: 'Förväntad medlem', className: 'expected' };
  return { symbol: '◇', label: 'Utanför matrikeln', className: 'outside' };
}

export function buildGraph(people, relations) {
  const byId = new Map(people.map((person) => [person.id, person]));
  const parents = new Map();
  const children = new Map();
  const partners = new Map();
  const all = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  const connectAll = (from, to, relation) => {
    add(all, from, { id: to, relation });
    add(all, to, { id: from, relation });
  };

  for (const relation of relations) {
    const from = byId.get(relation.from_person_id);
    const to = byId.get(relation.to_person_id);
    if (!from || !to) continue;
    connectAll(from.id, to.id, relation);
    if (relation.kind === 'foralder-barn') {
      add(children, from.id, { id: to.id, relation });
      add(parents, to.id, { id: from.id, relation });
    } else {
      add(partners, from.id, { id: to.id, relation });
      add(partners, to.id, { id: from.id, relation });
    }
  }

  for (const links of parents.values()) {
    const ids = [...new Set(links.map((link) => link.id))];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = ids[left];
        const b = ids[right];
        const exists = (partners.get(a) || []).some((link) => link.id === b);
        if (exists) continue;
        const relation = { id: `derived:coparent:${[a, b].sort().join(':')}`, kind: 'coparent', from_person_id: a, to_person_id: b, derived: true };
        add(partners, a, { id: b, relation });
        add(partners, b, { id: a, relation });
      }
    }
  }

  return { byId, parents, children, partners, all };
}

export function groupPeople(people) {
  const clans = new Map();
  for (const person of people) {
    const detailedClan = person.ui_clan || person.family || 'Utan känd släktkoppling';
    const base = clanBase(detailedClan);
    if (!clans.has(base)) clans.set(base, new Map());
    const families = clans.get(base);
    if (!families.has(detailedClan)) families.set(detailedClan, []);
    families.get(detailedClan).push(person);
  }
  return [...clans.entries()]
    .map(([name, families]) => ({ name, families, count: [...families.values()].reduce((total, entries) => total + entries.length, 0) }))
    .sort((a, b) => {
      const special = (group) => /Utan känd|Endast i/.test(group.name) ? 1 : 0;
      return special(a) - special(b) || b.count - a.count || a.name.localeCompare(b.name, 'sv');
    });
}

export function groupPeopleByProperty(people, properties) {
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const groups = new Map();
  const withoutProperty = [];
  for (const person of people) {
    const propertyIds = personPropertyIds(person);
    if (!propertyIds.length) {
      withoutProperty.push(person);
      continue;
    }
    for (const propertyId of propertyIds) {
      if (!groups.has(propertyId)) groups.set(propertyId, []);
      groups.get(propertyId).push(person);
    }
  }
  const result = [...groups.entries()].map(([propertyId, entries]) => ({
    id: propertyId,
    property: propertyById.get(propertyId) || { id: propertyId, display_name: propertyId, island: null },
    people: entries,
  })).sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true }));
  if (withoutProperty.length) result.push({
    id: '__none__',
    property: { id: '__none__', display_name: 'Utan fastighetskoppling', island: null },
    people: withoutProperty,
  });
  return result;
}

export function componentSets(people, relations) {
  const ids = new Set(people.map((person) => person.id));
  const adjacency = new Map([...ids].map((id) => [id, new Set()]));
  for (const relation of relations) {
    const from = relation.from_person_id;
    const to = relation.to_person_id;
    if (!ids.has(from) || !ids.has(to)) continue;
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  }
  const unseen = new Set(ids);
  const result = [];
  while (unseen.size) {
    const start = unseen.values().next().value;
    const stack = [start];
    const part = new Set();
    unseen.delete(start);
    while (stack.length) {
      const id = stack.pop();
      part.add(id);
      for (const next of adjacency.get(id)) {
        if (!unseen.has(next)) continue;
        unseen.delete(next);
        stack.push(next);
      }
    }
    result.push(part);
  }
  return result.sort((a, b) => b.size - a.size);
}

export function relationshipPath(fromId, toId, graph) {
  if (!graph.byId.has(fromId) || !graph.byId.has(toId)) return null;
  const queue = [fromId];
  const previous = new Map([[fromId, null]]);
  while (queue.length) {
    const current = queue.shift();
    if (current === toId) break;
    for (const link of graph.all.get(current) || []) {
      if (previous.has(link.id)) continue;
      previous.set(link.id, { id: current, relation: link.relation });
      queue.push(link.id);
    }
  }
  if (!previous.has(toId)) return null;
  const path = [];
  let current = toId;
  while (current !== fromId) {
    const step = previous.get(current);
    path.push({ from: step.id, to: current, relation: step.relation });
    current = step.id;
  }
  return path.reverse();
}

export function relationDescription(step, graph) {
  const relation = step.relation;
  const from = shownName(graph.byId.get(step.from));
  const to = shownName(graph.byId.get(step.to));
  if (relation.kind === 'foralder-barn') {
    return relation.from_person_id === step.from ? `${from} är förälder till ${to}` : `${from} är barn till ${to}`;
  }
  if (relation.kind === 'tidigare') return `${from} och ${to} var tidigare partner`;
  if (relation.kind === 'coparent') return `${from} och ${to} har barn tillsammans`;
  return `${from} och ${to} är partner`;
}

export function lineageIds(personId, graph) {
  const result = new Set([personId]);
  const visit = (map, id) => {
    for (const link of map.get(id) || []) {
      if (result.has(link.id)) continue;
      result.add(link.id);
      visit(map, link.id);
    }
  };
  visit(graph.parents, personId);
  visit(graph.children, personId);
  for (const link of graph.partners.get(personId) || []) result.add(link.id);
  return result;
}

export function visiblePersonIds(people, graph, filters) {
  const selectedGenerations = filters.generations || new Set();
  return new Set(people.filter((person) => {
    const propertyIds = personPropertyIds(person);
    if (filters.island && !resolvedIslands(person).includes(filters.island)) return false;
    if (filters.property === '__none__' && propertyIds.length) return false;
    if (filters.property && filters.property !== '__none__' && !propertyIds.includes(filters.property)) return false;
    if (filters.living && (person.living || 'okänt') !== filters.living) return false;
    if (!filters.includeInlaws && person.ui_is_inlaw) return false;
    if (filters.onlyUnlinked && (graph.all.get(person.id) || []).length) return false;
    if (selectedGenerations.size && !selectedGenerations.has(String(generationFor(person) ?? 'okand'))) return false;
    if (filters.yearOn) {
      const birth = Number(String(person.birth ?? '').slice(0, 4));
      const death = Number(String(person.death ?? '').slice(0, 4));
      if (Number.isFinite(birth) && birth > filters.year) return false;
      if (Number.isFinite(death) && death < filters.year) return false;
    }
    return true;
  }).map((person) => person.id));
}
