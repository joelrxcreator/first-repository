// Zeit-Helfer. Intern rechnet der Planer in "Minuten seit lokaler Mitternacht"
// eines Datums (Europe/Berlin), unabhängig davon, in welcher Zeitzone der Server läuft.

export const TZ = 'Europe/Berlin';

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(date) {
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return p;
}

/** Offset der lokalen Zeitzone gegenüber UTC in Minuten (z. B. +120 im Sommer). */
export function tzOffsetMin(date) {
  const p = parts(date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Lokales Datum ('YYYY-MM-DD'), Minuten seit Mitternacht und Wochentag (0 = Montag). */
export function localParts(date) {
  const p = parts(date);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  return { dateStr, minutes: +p.hour * 60 + +p.minute + +p.second / 60, weekday: weekdayOf(dateStr) };
}

/** Wochentag eines Datums, 0 = Montag … 6 = Sonntag. */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Lokales Datum + Minute → echter Zeitpunkt (Date). Minuten dürfen < 0 oder > 1440 sein. */
export function zonedToUtc(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + Math.round(minutes * 60000);
  let off = tzOffsetMin(new Date(guess));
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

/** Zeitpunkt → lokale Uhrzeit in Minuten relativ zu dateStr (Vortag negativ, Folgetag > 1440). */
export function minutesOn(dateStr, date) {
  const lp = localParts(date);
  return daysBetween(dateStr, lp.dateStr) * 1440 + lp.minutes;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function parseHM(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function fmtHM(min) {
  const m = Math.round(min);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

export function fmtDur(min) {
  const m = Math.round(Math.abs(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
