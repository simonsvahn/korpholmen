const clean = value => String(value ?? '').trim();
const yearNumber = value => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1000 && number <= 2200 ? number : null;
};

function yearWindow(item, prefix) {
  const exact = yearNumber(item?.[`${prefix}_year`]);
  if (exact) return { min: exact, max: exact, precision: item?.[`${prefix}_precision`] || 'år', qualifier: item?.[`${prefix}_qualifier`] || null };
  const min = yearNumber(item?.[`${prefix}_year_min`]);
  const max = yearNumber(item?.[`${prefix}_year_max`]);
  if (!min && !max) return null;
  return { min: min || max, max: max || min, precision: item?.[`${prefix}_precision`] || (min === max ? 'år' : 'intervall'), qualifier: item?.[`${prefix}_qualifier`] || null };
}

function fallbackWindow(value) {
  const source = clean(value);
  const fullDecade = source.match(/\b(1\d{3}|20\d{2})-talet\b/i);
  if (fullDecade) return { min: Number(fullDecade[1]), max: Number(fullDecade[1]) + 9, precision: 'decennium', qualifier: /slutet/i.test(source) ? 'slutet' : null };
  const shortDecade = source.match(/\b(\d{2})-talet\b/i);
  if (shortDecade) return { min: Number(`19${shortDecade[1]}`), max: Number(`19${shortDecade[1]}`) + 9, precision: 'decennium', qualifier: /slutet/i.test(source) ? 'slutet' : null };
  const exact = source.match(/^\s*(1[7-9]\d{2}|20\d{2})\s*$/);
  return exact ? { min: Number(exact[1]), max: Number(exact[1]), precision: 'år' } : null;
}

export function formatYearWindow(window) {
  if (!window) return null;
  if (window.min === window.max) return /ungefär|cirka/i.test(window.precision) ? `cirka ${window.min}` : String(window.min);
  if (/decennium/i.test(window.precision)) {
    const decade = `${window.min}-talet`;
    if (window.qualifier === 'slutet') return `slutet av ${decade}`;
    if (window.qualifier === 'början') return `början av ${decade}`;
    if (window.qualifier === 'mitten') return `mitten av ${decade}`;
    return decade;
  }
  return `${window.min}–${window.max}`;
}

export function itemStartWindow(item) {
  return yearWindow(item, 'start') || fallbackWindow(item?.period_text || item?.date_text);
}

export function itemEndWindow(item) {
  return yearWindow(item, 'end');
}

export function itemSortYear(item) {
  return itemStartWindow(item)?.min || yearNumber(item?.year_min) || yearNumber(item?.year_max) || null;
}

function fallbackPeriod(item) {
  const source = clean(item?.period_text || item?.date_text);
  if (!source) return null;
  return source
    .replace(/\b(\d{2})-talet\b/gi, (_, decade) => `19${decade}-talet`)
    .replace(/\b(1\d{2}|20\d)X\b\??/gi, (_, stem) => `${stem}0-talet`);
}

export function sourcePeriod(item) {
  const startWindow = itemStartWindow(item);
  const endWindow = itemEndWindow(item);
  const start = formatYearWindow(startWindow);
  const end = formatYearWindow(endWindow);
  if (start && end) return `${start}–${end}`;
  if (start && item?.ongoing) return `${start}–`;
  if (start) return start;
  if (end) return `Okänt–${end}`;
  return fallbackPeriod(item) || 'Odaterat';
}

export function roleLabel(role, holderText = '') {
  const value = clean(role).toLocaleLowerCase('sv');
  const plural = /\boch\b|,/.test(holderText);
  if (value.includes('hyresgäst')) return plural ? 'Hyresgäster' : 'Hyresgäst';
  if (value.includes('pensionat') || value.includes('verksamhetsutövare')) return 'Verksamhetsutövare';
  if (value === 'boende/brukare' || value.includes('familjeinnehav/boende') || value.includes('boende/familjeinnehav')) return plural ? 'Boende' : 'Boende';
  if (value.includes('gåvomottagare/brukare')) return plural ? 'Gåvomottagare / brukare' : 'Gåvomottagare / brukare';
  if (value.includes('köparclaim/brukare')) return 'Möjlig köpare / brukare';
  if (value.includes('brukare/öanknuten')) return 'Brukare';
  if (value.includes('bruk/fastighetskaraktär')) return 'Användning';
  if (value.includes('dödsbo')) return 'Dödsbo';
  if (value.includes('samfällt')) return 'Samfällt ägande';
  if (value.includes('organisationsägande')) return 'Organisation';
  if (value.includes('möjlig ägare') || value.includes('innehavare')) return 'Ägare?';
  if (value.includes('lagfaren ägare') || value === 'ägare') return plural ? 'Ägare' : 'Ägare';
  return clean(role) || 'Roll okänd';
}

export function isUncertain(item) {
  const status = clean(item?.verification_status);
  const unsupportedWorkingClaim = status && !/belagd/i.test(status) && /arbetsnot|uppgift|anspråk|okänd|osäker/i.test(status);
  return unsupportedWorkingClaim || /osäker|möjlig|härledd|okänd|\?/i.test([item?.certainty, status, item?.period_text, item?.holder_text].join(' '));
}

export function buildClaimChain(claims = []) {
  const ordered = [...claims].sort((a, b) => (a.order || 0) - (b.order || 0));
  return ordered.map((claim, index) => {
    const next = ordered[index + 1] || null;
    const start = itemStartWindow(claim);
    const end = itemEndWindow(claim);
    const nextStart = next ? itemStartWindow(next) : null;
    let periodLabel = sourcePeriod(claim);
    let derivedEnd = false;
    if (start && !end && nextStart && nextStart.min === nextStart.max) {
      periodLabel = `${formatYearWindow(start)}–${formatYearWindow(nextStart)}`;
      derivedEnd = true;
    }
    return {
      ...claim,
      chain_index: index + 1,
      period_label: periodLabel,
      role_label: roleLabel(claim.role, claim.holder_text),
      uncertain: isUncertain(claim),
      unverified: Boolean(claim.verification_status) && !/belagd/i.test(claim.verification_status),
      derived_end: derivedEnd,
      next_claim_id: next?.id || null,
    };
  });
}

export function currentClaimMatchesNames(claim, names = []) {
  const tokens = value => clean(value)
    .toLocaleLowerCase('sv')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const holderTokens = tokens(claim?.holder_text);
  const holderSet = new Set(holderTokens);
  const haystack = holderTokens.join(' ');
  if (!names.length) return false;
  return names.every(name => {
    const nameTokens = tokens(name);
    if (!nameTokens.length) return false;
    if (haystack.includes(nameTokens.join(' '))) return true;
    if (nameTokens.length < 2) return false;
    const surname = nameTokens.at(-1);
    const givenNames = nameTokens.slice(0, -1);
    return holderSet.has(surname) && givenNames.some(givenName => holderSet.has(givenName));
  });
}

export function sameClaimIdentity(left, right) {
  const leftYear = itemSortYear(left) || yearNumber(left?.sort_year);
  const rightYear = itemSortYear(right) || yearNumber(right?.sort_year);
  if (!leftYear || leftYear !== rightYear) return false;
  if (left?.party_id && right?.party_id) return left.party_id === right.party_id;
  const leftHolder = clean(left?.holder_text).toLocaleLowerCase('sv');
  const rightHolder = clean(right?.holder_text).toLocaleLowerCase('sv');
  if (!leftHolder || leftHolder !== rightHolder) return false;
  const leftSources = new Set(Array.isArray(left?.source_ids) ? left.source_ids : []);
  const rightSources = Array.isArray(right?.source_ids) ? right.source_ids : [];
  return rightSources.some(sourceId => leftSources.has(sourceId));
}
