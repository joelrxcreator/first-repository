// Baut aus den Einstellungen (Wochenvorlage + Termine + Ausnahmen) den konkreten Tag.
import { parseHM, weekdayOf } from './time.js';

export const DEFAULT_SETTINGS = {
  version: 1,
  locations: {
    home: { label: 'Zuhause', address: '', lat: null, lon: null },
    work: { label: 'Arbeit', address: '', lat: null, lon: null },
    uni: { label: 'Uni', address: '', lat: null, lon: null },
  },
  work: {
    location: 'work',
    // Pause hängt an der Arbeitszeit: mehr als 6 h → 30 min, mehr als 9 h → 45 min.
    pauseRules: [{ overHours: 6, pauseMin: 30 }, { overHours: 9, pauseMin: 45 }],
    // Wochentag 0 = Montag … 6 = Sonntag; hours 0 = frei
    days: {
      0: { hours: 8, earliest: '06:30', latest: '19:00' },
      1: { hours: 8, earliest: '06:30', latest: '19:00' },
      2: { hours: 4, earliest: '06:30', latest: '19:00' },
      3: { hours: 8, earliest: '06:30', latest: '19:00' },
      4: { hours: 4, earliest: '06:30', latest: '19:00' },
      5: { hours: 0 },
      6: { hours: 0 },
    },
  },
  // Wiederkehrende Veranstaltungen: kind 'mandatory' (Pflicht) oder 'optional'
  study: [],
  // Einmalige Termine: category 'private' | 'study' | 'other'; kind 'mandatory' | 'optional'
  appointments: [],
  // Ausnahmen pro Datum: { work: null | {hours, earliest, latest}, skip: [eventIds] }
  overrides: {},
  priorities: {
    commute: 1.0, // 1 Minute im Auto
    away: 0.35, // 1 Minute weg von zuhause (Freizeit geht verloren)
    optionalMissed: 0.5, // 1 Minute verpasste optionale Veranstaltung / Termin
  },
  planning: {
    stepMin: 5,
    bufferMin: 5, // Puffer vor Terminen
    maxWaitAfterMin: 120, // so lange darf man nach Feierabend/Vorlesung noch bleiben
    dayStart: '04:30',
    dayEnd: '23:30',
    baseTravelMin: 35, // Fahrzeit ohne Verkehr, nur solange keine echten Daten da sind
  },
  notify: {
    ntfyTopic: '',
    eveningTime: '20:00',
    leadMin: 15,
    changeThresholdMin: 5,
    quietStart: '22:30',
    quietEnd: '05:30',
  },
  traffic: {
    provider: 'demo', // 'demo' oder 'tomtom'
    tomtomKey: '',
    apiDailyLimit: 2000,
  },
};

/** Füllt fehlende Felder mit Standardwerten auf (flach pro Bereich). */
export function withDefaults(s = {}) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const k of Object.keys(s || {})) {
    const v = s[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function pauseFor(hours, rules) {
  let p = 0;
  for (const r of rules || []) if (hours > r.overHours) p = Math.max(p, r.pauseMin);
  return p;
}

/** Konkreter Tag: Arbeitsblock (flexibel) + feste Termine. Zeiten in Minuten. */
export function buildDay(settingsIn, dateStr) {
  const s = withDefaults(settingsIn);
  const weekday = weekdayOf(dateStr);
  const ov = s.overrides?.[dateStr] || {};
  const skip = new Set(ov.skip || []);

  let w = 'work' in ov ? ov.work : s.work.days?.[weekday];
  let work = null;
  if (w && Number(w.hours) > 0) {
    const tmpl = s.work.days?.[weekday] || {};
    const hours = Number(w.hours);
    const pause = pauseFor(hours, s.work.pauseRules);
    work = {
      hours,
      pauseMin: pause,
      duration: Math.round(hours * 60 + pause),
      earliest: parseHM(w.earliest ?? tmpl.earliest ?? '06:00'),
      latest: parseHM(w.latest ?? tmpl.latest ?? '20:00'),
      location: w.location || s.work.location || 'work',
    };
    if (work.latest - work.earliest < work.duration) work.latest = work.earliest + work.duration;
  }

  const events = [];
  for (const e of s.study || []) {
    if (Number(e.weekday) !== weekday) continue;
    if (e.from && dateStr < e.from) continue;
    if (e.until && dateStr > e.until) continue;
    if (skip.has(e.id)) continue;
    events.push(norm(e, 'study'));
  }
  for (const e of s.appointments || []) {
    if (e.date !== dateStr || skip.has(e.id)) continue;
    events.push(norm(e, e.category || 'private'));
  }
  events.sort((a, b) => a.start - b.start);
  return { date: dateStr, weekday, work, events };
}

function norm(e, category) {
  return {
    id: e.id,
    title: e.title || 'Termin',
    start: parseHM(e.start),
    end: parseHM(e.end),
    location: e.location || 'uni',
    kind: e.kind === 'optional' ? 'optional' : 'mandatory',
    category,
  };
}

/** Alle Orte, die an diesem Tag vorkommen (inkl. Zuhause). */
export function dayLocations(day) {
  const set = new Set(['home']);
  if (day.work) set.add(day.work.location);
  for (const e of day.events) set.add(e.location);
  return [...set];
}
