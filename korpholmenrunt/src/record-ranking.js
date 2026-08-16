import { parseRaceTime } from './time.js';

const COURSE_ORDER = ['S', 'L'];
const COURSE_NAMES = new Map([
  ['S', 'Stora banan'],
  ['L', 'Lilla banan'],
]);

const REASON_LABELS = new Map([
  ['missing-course', 'Bana saknas'],
  ['missing-class', 'Klass behöver granskas'],
]);

const STATUS_LABELS = new Map([
  ['osäker', 'Osäker tid'],
  ['minimivärde', 'Minimitid'],
  ['ogiltig sekunddel', 'Otolkad råtid'],
  ['ogiltigt format', 'Otolkad råtid'],
  ['saknas', 'Tid saknas'],
  ['fusk', 'Fusk'],
]);

const compareSv = (left, right) => String(left || '').localeCompare(String(right || ''), 'sv', { numeric: true });

export function historicalTimeNormalization(result) {
  if (![2010, 2011].includes(Number(result?.year))) return null;
  const match = String(result?.time_raw || '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 59) return null;
  return {
    seconds: Number(match[1]) * 60 + Number(match[2]),
    status: 'tolkad',
    method: 'hundradelar-strukna',
  };
}

function timeAssessment(result) {
  const stored = Number.isFinite(result?.duration_seconds) && result.duration_seconds >= 0;
  if (stored) {
    const status = result.time_status || 'tolkad';
    return { seconds: result.duration_seconds, status, derived: false };
  }
  if (result?.time_status && result.time_status !== 'tolkad') return { seconds: null, status: result.time_status, derived: false };
  const historical = historicalTimeNormalization(result);
  if (historical) return { seconds: historical.seconds, status: historical.status, derived: true };
  const parsed = parseRaceTime(result?.time_raw);
  return { seconds: parsed.seconds, status: parsed.status, derived: parsed.status === 'tolkad' };
}

export function assessRecordResult(result) {
  const time = timeAssessment(result);
  const reason = (!COURSE_NAMES.has(result?.course_code) ? 'missing-course' : null)
    || (!result?.class_id ? 'missing-class' : null);
  return {
    result,
    seconds: time.seconds,
    derivedTime: time.derived,
    groupable: !reason,
    rankable: Number.isFinite(time.seconds),
    timeStatus: time.status,
    timeStatusLabel: time.status === 'tolkad' ? null : STATUS_LABELS.get(time.status) || time.status,
    reason,
    reasonLabel: reason ? REASON_LABELS.get(reason) : null,
  };
}

export function normalizationForResult(result) {
  if (Number.isFinite(result?.duration_seconds) && result.duration_seconds >= 0) return null;
  const historical = historicalTimeNormalization(result);
  if (historical) return { duration_seconds: historical.seconds, time_status: historical.status };
  const parsed = parseRaceTime(result?.time_raw);
  if (parsed.status !== 'tolkad') return null;
  return { duration_seconds: parsed.seconds, time_status: 'tolkad' };
}

function ranked(items) {
  let priorSeconds = null;
  let rank = 0;
  return [...items]
    .sort((left, right) => {
      if (left.rankable && right.rankable) return left.seconds - right.seconds || Number(left.result.year) - Number(right.result.year) || compareSv(left.result.id, right.result.id);
      if (left.rankable) return -1;
      if (right.rankable) return 1;
      return Number(left.result.year) - Number(right.result.year) || compareSv(left.result.id, right.result.id);
    })
    .map((item, index) => {
      if (!item.rankable) return { ...item, rank: null };
      if (item.seconds !== priorSeconds) rank = index + 1;
      priorSeconds = item.seconds;
      return { ...item, rank };
    });
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.trunc(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function recordTimeLabel(item) {
  if (item.timeStatus === 'fusk') return 'Fusk';
  return formatDuration(item.seconds) || String(item.result?.time_raw || '').trim() || '—';
}

export function buildRecordViewModel(results, { limit = 10, expandedGroups = new Set() } = {}) {
  const assessed = results.map(assessRecordResult);
  const groupedResults = assessed.filter(item => item.groupable);
  const ungrouped = assessed
    .filter(item => !item.groupable)
    .sort((left, right) => compareSv(left.reasonLabel, right.reasonLabel) || Number(right.result.year) - Number(left.result.year) || compareSv(left.result.id, right.result.id));
  const grouped = new Map();
  for (const item of groupedResults) {
    const key = `${item.result.course_code}|${item.result.class_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const sections = COURSE_ORDER.map(courseCode => {
    const groups = [...grouped]
      .filter(([key]) => key.startsWith(`${courseCode}|`))
      .map(([key, items]) => {
        const all = ranked(items);
        const expanded = expandedGroups.has(key);
        return {
          key,
          classId: all[0].result.class_id,
          className: all[0].result.class_name || all[0].result.class_raw || 'Okänd klass',
          total: all.length,
          expanded,
          items: expanded ? all : all.slice(0, limit),
        };
      })
      .sort((left, right) => compareSv(left.className, right.className));
    return { courseCode, courseName: COURSE_NAMES.get(courseCode), groups };
  }).filter(section => section.groups.length);
  return {
    sections,
    ungrouped,
    total: results.length,
    grouped: groupedResults.length,
    rankable: assessed.filter(item => item.rankable).length,
    withoutNumericTime: assessed.filter(item => !item.rankable).length,
    derivedTimes: assessed.filter(item => item.derivedTime).length,
    initiallyShown: sections.reduce((sum, section) => sum + section.groups.reduce((inner, group) => inner + Math.min(group.total, limit), 0), 0),
    limit,
  };
}
