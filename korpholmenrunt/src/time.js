export function parseRaceTime(raw) {
  const value = String(raw || '').trim();
  if (!value) return { seconds: null, status: 'saknas' };
  const match = value.match(/^(\d+)[:,.](\d{2})(\?)?$/);
  if (!match) return { seconds: null, status: value.endsWith('+') ? 'minimivärde' : 'ogiltigt format' };
  const seconds = Number(match[2]);
  if (seconds > 59) return { seconds: null, status: 'ogiltig sekunddel' };
  return { seconds: Number(match[1]) * 60 + seconds, status: match[3] ? 'osäker' : 'tolkad' };
}
