// Tagesoptimierer: probiert Arbeitsbeginn, Abfahrtszeiten und (bei optionalen
// Terminen) Teilnahme-Varianten durch und bewertet jede Kombination mit den
// persönlichen Gewichten. Pflichttermine sind harte Bedingungen.
import { parseHM } from './time.js';

/**
 * @param day      Ergebnis von buildDay()
 * @param travel   (from, to, minuteOfDay) => Fahrzeit in Minuten
 * @param settings Einstellungen (withDefaults)
 * @param opts     { nowMin, state: { location, availableFrom, workStart, workDone } }
 */
export function planDay(day, travel, settings, opts = {}) {
  const plan = planCore(day, travel, settings, opts, false);
  if (plan.scenarios.length || !day.events.some((e) => e.kind === 'mandatory')) return plan;
  // Notlösung: Pflichttermine sind nicht alle erreichbar → trotzdem den Rest des Tages planen,
  // Pflichttermine aber mit sehr hohem Gewicht möglichst wahrnehmen.
  const rescue = planCore(day, travel, settings, opts, true);
  if (!rescue.scenarios.length) return plan;
  const missed = new Set();
  for (const e of rescue.scenarios[0].events) if (e.kind === 'mandatory' && e.missed > 0) missed.add(e.title);
  rescue.warnings.unshift(missed.size
    ? `Nicht alles schaffbar: ${[...missed].map((t) => `„${t}“`).join(', ')} ist mit Arbeitszeit und Fahrzeiten nicht vollständig erreichbar. Unten der bestmögliche Plan – bitte selbst entscheiden.`
    : 'Pflichttermine und Arbeitszeit passen nur knapp zusammen.');
  return rescue;
}

function planCore(day, travel, settings, opts, rescue) {
  const P = settings.planning, W = settings.priorities;
  const step = P.stepMin || 5;
  const buffer = P.bufferMin ?? 5;
  const maxWait = P.maxWaitAfterMin ?? 120;
  const dayStart = parseHM(P.dayStart) ?? 270;
  const dayEnd = parseHM(P.dayEnd) ?? 1410;
  const nowMin = opts.nowMin ?? null;
  const state = opts.state || {};
  const startLoc = state.location || 'home';
  const startFree = Math.max(dayStart, nowMin ?? -Infinity, state.availableFrom ?? -Infinity);
  const warnings = [];

  // --- Termine einsortieren -------------------------------------------------
  const fixed = [];
  const optional = [];
  const dropped = [];
  for (const e of day.events) {
    if (nowMin != null && e.end <= nowMin) continue; // schon vorbei
    if (nowMin != null && e.start < nowMin) { // läuft gerade
      if (e.location === startLoc) fixed.push({ ...e, inProgress: true });
      else dropped.push(e);
      continue;
    }
    (e.kind === 'mandatory' && !rescue ? fixed : optional).push(e);
  }
  for (const e of dropped) if (e.kind === 'mandatory') warnings.push(`„${e.title}“ läuft bereits und ist nicht mehr erreichbar.`);

  // --- Arbeitsblock-Varianten ----------------------------------------------
  const wk = day.work && !state.workDone ? day.work : null;
  let workOpts = [null];
  if (wk) {
    if (state.workStart != null) {
      workOpts = [{ start: state.workStart, end: state.workStart + wk.duration }];
    } else {
      workOpts = [];
      for (let s = Math.ceil(wk.earliest / step) * step; s + wk.duration <= wk.latest; s += step) {
        if (nowMin != null && s < nowMin) continue;
        workOpts.push({ start: s, end: s + wk.duration });
      }
      if (!workOpts.length) {
        warnings.push('Die Arbeitszeit passt heute nicht mehr in das erlaubte Zeitfenster.');
        workOpts = [null];
      }
    }
  }

  // --- Varianten für optionale Termine -------------------------------------
  let variantLists = optional.map((e) => {
    const dur = e.end - e.start;
    const v = [{ e, start: e.start, end: e.end, missed: 0 }, { e, skip: true, missed: dur }];
    if (dur >= 30) {
      for (let k = 15; k <= dur - 15; k += 15) {
        v.push({ e, start: e.start + k, end: e.end, missed: k, partial: 'late' });
        v.push({ e, start: e.start, end: e.end - k, missed: k, partial: 'early' });
      }
    }
    return v;
  });
  if (variantLists.reduce((p, v) => p * v.length, 1) > 400) variantLists = variantLists.map((v) => v.slice(0, 2));
  const missWeight = (e) => (e.kind === 'mandatory' ? 50 : W.optionalMissed);
  const combos = variantLists.reduce((acc, list) => acc.flatMap((c) => list.map((v) => [...c, v])), [[]]);

  // --- Fahrten ---------------------------------------------------------------
  const ttCache = new Map();
  const tt = (a, b, d) => {
    const k = `${a}|${b}|${d}`;
    let v = ttCache.get(k);
    if (v === undefined) {
      v = Math.max(1, Math.round(travel(a, b, d)));
      ttCache.set(k, v);
    }
    return v;
  };

  const legCache = new Map();
  // Beste Abfahrt von `from` nach `to`, frühestens ab `free`.
  // deadline = späteste Ankunft (nächster Termin), null = Heimfahrt ohne Frist.
  function bestLeg(from, to, free, deadline) {
    const key = `${from}|${to}|${free}|${deadline}`;
    if (legCache.has(key)) return legCache.get(key);
    const lo = Math.ceil(Math.max(free, nowMin ?? -Infinity) / step) * step;
    const hi = deadline != null ? deadline - buffer : Math.max(lo, Math.min(free + maxWait, dayEnd));
    let best = null;
    for (let d = lo; d <= hi; d += step) {
      const t = tt(from, to, d);
      const arr = d + t;
      if (deadline != null && arr > deadline - buffer) continue;
      let cost = W.commute * t;
      if (from === 'home') cost += W.away * ((deadline ?? arr) - d);
      if (to === 'home') cost += W.away * (arr - free);
      if (!best || cost < best.cost - 1e-9) best = { from, to, depart: d, arrive: arr, minutes: t, cost, wait: d - free };
    }
    legCache.set(key, best);
    return best;
  }

  // --- Alle Kombinationen bewerten ----------------------------------------
  const results = [];
  for (const w of workOpts) {
    for (const combo of combos) {
      const acts = fixed.map((e) => ({ type: 'event', e, start: e.start, end: e.end, loc: e.location }));
      for (const v of combo) if (!v.skip) acts.push({ type: 'event', e: v.e, start: v.start, end: v.end, loc: v.e.location });
      if (w) acts.push({ type: 'work', start: w.start, end: w.end, loc: wk.location });
      acts.sort((a, b) => a.start - b.start);

      let ok = true;
      for (let i = 1; i < acts.length; i++) if (acts[i].start < acts[i - 1].end) { ok = false; break; }
      if (!ok) continue;

      // Zeit unterwegs: Die Fahrten-Kosten enthalten schon die Zeit vor dem ersten
      // und nach dem letzten Termin; hier kommt die Zeit dazwischen (Termine + Wartezeit).
      let loc = startLoc, free = startFree, cost = 0;
      let segStart = startLoc === 'home' ? null : startFree;
      const legs = [];
      for (const a of acts) {
        if (a.loc !== loc) {
          const L = bestLeg(loc, a.loc, free, a.start);
          if (!L) { ok = false; break; }
          legs.push(L);
          cost += L.cost;
          if (a.loc === 'home' && segStart != null) { cost += W.away * (free - segStart); segStart = null; }
          if (loc === 'home') segStart = a.start;
          loc = a.loc;
          free = a.end;
        } else {
          free = Math.max(free, a.end);
        }
      }
      if (!ok) continue;
      if (loc !== 'home') {
        const L = bestLeg(loc, 'home', free, null);
        if (!L) continue;
        legs.push(L);
        cost += L.cost;
        if (segStart != null) cost += W.away * (free - segStart);
      }
      cost += combo.reduce((s, v) => s + missWeight(v.e) * v.missed, 0);
      results.push({ cost, legs, work: w, combo });
    }
  }

  if (!results.length) {
    warnings.push('Keine machbare Kombination gefunden – Pflichttermine, Arbeitszeit und Fahrzeiten passen nicht zusammen. Bitte Arbeitszeitfenster oder Termine prüfen.');
    return { date: day.date, scenarios: [], warnings };
  }

  results.sort((a, b) => a.cost - b.cost);
  const picked = pickDiverse(results, 6);
  const scenarios = picked.map((r, i) => toScenario(r, i, fixed, optional, tt, startLoc));
  return { date: day.date, scenarios, warnings };
}

function pickDiverse(results, n) {
  const picked = [];
  const key = (r) => `${r.work ? r.work.start : '-'}|${r.legs.map((l) => l.depart).join(',')}|${sigCombo(r)}`;
  const add = (r) => { if (r && picked.length < n && !picked.some((p) => key(p) === key(r))) picked.push(r); };
  const dep0 = (r) => (r.legs[0] ? r.legs[0].depart : -999);
  const depN = (r) => (r.legs.length ? r.legs[r.legs.length - 1].depart : -999);
  // "Spürbar anders" = andere Teilnahme-Art oder Abfahrten mind. 45 min verschoben
  const ws = (r) => (r.work ? r.work.start : -999);
  const miss = (r) => r.combo.reduce((s, v) => s + v.missed, 0);
  const similar = (a, b) => Math.abs(miss(a) - miss(b)) < 45 && Math.abs(dep0(a) - dep0(b)) < 45
    && Math.abs(depN(a) - depN(b)) < 45 && Math.abs(ws(a) - ws(b)) < 45;

  add(results[0]);
  // Gezielte Alternativen: was wäre, wenn man nur auf X schaut?
  const by = (f) => results.reduce((b, r) => (f(r) < f(b) - 1e-9 || (Math.abs(f(r) - f(b)) < 1e-9 && r.cost < b.cost) ? r : b), results[0]);
  const commute = (r) => r.legs.reduce((s, l) => s + l.minutes, 0);
  const home = (r) => { const l = r.legs.filter((x) => x.to === 'home').pop(); return l ? l.arrive : 0; };
  const missed = (r) => r.combo.reduce((s, v) => s + v.missed, 0);
  for (const r of [by(commute), by(home), results.some((x) => missed(x) > 0) ? by(missed) : null]) {
    if (r && !picked.some((p) => similar(p, r))) add(r);
  }
  for (const r of results) {
    if (picked.length >= n) break;
    if (!picked.some((p) => similar(p, r))) add(r);
  }
  // Beste zuerst, Rest nach Bewertung
  return [picked[0], ...picked.slice(1).sort((a, b) => a.cost - b.cost)];
}

function sigCombo(r) {
  return r.combo.map((v) => (v.skip ? 's' : v.partial ? `${v.partial[0]}${v.missed}` : 'f')).join(',');
}

function toScenario(r, i, fixed, optional, tt, startLoc) {
  const legs = r.legs.map((l) => ({
    from: l.from, to: l.to, depart: l.depart, arrive: l.arrive, minutes: l.minutes, wait: l.wait,
    around: [-30, -15, 15, 30].map((o) => ({ depart: l.depart + o, minutes: tt(l.from, l.to, l.depart + o) })),
  }));
  const events = [
    ...fixed.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, kind: e.kind, category: e.category, location: e.location, attend: 'full', missed: 0 })),
    ...r.combo.map((v) => ({
      id: v.e.id, title: v.e.title, start: v.e.start, end: v.e.end, kind: v.e.kind, category: v.e.category, location: v.e.location,
      attend: v.skip ? 'skip' : v.partial || 'full', attendStart: v.skip ? null : v.start, attendEnd: v.skip ? null : v.end, missed: v.missed,
    })),
  ].sort((a, b) => a.start - b.start);

  let away = 0, leftAt = startLoc === 'home' ? null : -1;
  let leaveHome = null, arriveHome = null;
  for (const l of legs) {
    if (l.from === 'home') { leftAt = l.depart; if (leaveHome == null) leaveHome = l.depart; }
    if (l.to === 'home') { if (leftAt != null && leftAt >= 0) away += l.arrive - leftAt; arriveHome = l.arrive; leftAt = null; }
  }
  return {
    id: `s${i}`,
    score: Math.round(r.cost * 10) / 10,
    legs,
    work: r.work,
    events,
    totals: {
      commute: legs.reduce((s, l) => s + l.minutes, 0),
      away,
      leaveHome,
      arriveHome,
      optionalMissed: r.combo.reduce((s, v) => s + (v.e.kind === 'optional' ? v.missed : 0), 0),
    },
  };
}
