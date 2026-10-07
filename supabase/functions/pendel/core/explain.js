// Macht aus den Szenarien nachvollziehbare Texte: Was passiert, warum, was kostet die Alternative.
import { fmtHM, fmtDur } from './time.js';

export function placeName(settings, key) {
  return settings?.locations?.[key]?.label || { home: 'Zuhause', work: 'Arbeit', uni: 'Uni' }[key] || key;
}

const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');

/** Ergänzt Szenarien um label, summary, steps, reasons, diff (zur Empfehlung). */
export function explainPlan(plan, settings) {
  const best = plan.scenarios[0];
  if (!best) return plan;
  for (const s of plan.scenarios) {
    s.steps = steps(s, settings);
    s.reasons = reasons(s, settings);
    if (s === best) {
      s.label = 'Empfehlung';
      s.diff = null;
    } else {
      const d = {
        commute: s.totals.commute - best.totals.commute,
        arriveHome: (s.totals.arriveHome ?? 0) - (best.totals.arriveHome ?? 0),
        leaveHome: (s.totals.leaveHome ?? 0) - (best.totals.leaveHome ?? 0),
        optionalMissed: s.totals.optionalMissed - best.totals.optionalMissed,
      };
      s.diff = d;
      s.label = labelFor(s, d);
      s.diffText = diffText(d, s, best);
    }
    s.summary = summary(s, settings);
  }
  return plan;
}

function labelFor(s, d) {
  if (d.optionalMissed < 0) return 'Mehr von den Veranstaltungen';
  if (d.commute <= -3) return 'Weniger Pendelzeit';
  if (d.arriveHome <= -10) return 'Früher zu Hause';
  if (d.leaveHome >= 15) return 'Später anfangen';
  if (d.leaveHome <= -15) return 'Früher anfangen, früher heim';
  return 'Alternative';
}

function diffText(d, s, best) {
  const out = [];
  if (d.commute) out.push(`${sign(d.commute)}${fmtDur(d.commute)} im Auto`);
  if (d.arriveHome && s.totals.arriveHome != null) out.push(d.arriveHome < 0 ? `${fmtDur(d.arriveHome)} früher zu Hause` : `${fmtDur(d.arriveHome)} später zu Hause`);
  if (d.leaveHome && s.totals.leaveHome != null) out.push(d.leaveHome < 0 ? `${fmtDur(d.leaveHome)} früher los` : `${fmtDur(d.leaveHome)} später los`);
  if (d.optionalMissed) out.push(d.optionalMissed > 0 ? `${fmtDur(d.optionalMissed)} mehr verpasst` : `${fmtDur(d.optionalMissed)} mehr Veranstaltung`);
  return out.join(' · ') || 'praktisch gleichwertig';
}

function summary(s, settings) {
  const first = s.legs[0];
  if (!first) return 'Heute keine Fahrten nötig.';
  const parts = [`${fmtHM(first.depart)} los → ${placeName(settings, first.to)} ${fmtHM(first.arrive)}`];
  if (s.work) parts.push(`Arbeit ${fmtHM(s.work.start)}–${fmtHM(s.work.end)}`);
  const last = s.legs[s.legs.length - 1];
  if (last && last !== first) parts.push(`Heimfahrt ${fmtHM(last.depart)} → zu Hause ${fmtHM(last.arrive)}`);
  else if (last && last.to === 'home') parts.push(`zu Hause ${fmtHM(last.arrive)}`);
  parts.push(`${fmtDur(s.totals.commute)} Pendelzeit`);
  return parts.join(' · ');
}

function steps(s, settings) {
  const items = [];
  for (const l of s.legs) {
    items.push({ t: l.depart, type: 'drive', text: `Losfahren ${placeName(settings, l.from)} → ${placeName(settings, l.to)} (${fmtDur(l.minutes)}, an ${fmtHM(l.arrive)})` });
  }
  if (s.work) items.push({ t: s.work.start, type: 'work', text: `Arbeit ${fmtHM(s.work.start)}–${fmtHM(s.work.end)}` });
  for (const e of s.events) {
    const tag = e.kind === 'mandatory' ? 'Pflicht' : 'optional';
    let text = `${e.title} ${fmtHM(e.start)}–${fmtHM(e.end)} (${tag})`;
    if (e.attend === 'skip') text = `${e.title} auslassen (${tag}, ${fmtHM(e.start)}–${fmtHM(e.end)})`;
    else if (e.attend === 'late') text = `${e.title} ab ${fmtHM(e.attendStart)} (${fmtDur(e.missed)} später, ${tag})`;
    else if (e.attend === 'early') text = `${e.title} bis ${fmtHM(e.attendEnd)} (${fmtDur(e.missed)} früher gehen, ${tag})`;
    items.push({ t: e.attendStart ?? e.start, type: e.attend === 'skip' ? 'skip' : 'event', text });
  }
  return items.sort((a, b) => a.t - b.t);
}

function reasons(s, settings) {
  const out = [];
  for (const l of s.legs) {
    const worse = l.around.filter((a) => a.minutes > l.minutes + 2);
    const better = l.around.filter((a) => a.minutes < l.minutes - 2);
    const where = `${placeName(settings, l.from)} → ${placeName(settings, l.to)}`;
    if (worse.length) {
      const w = worse.sort((a, b) => b.minutes - a.minutes)[0];
      out.push(`${where}: Abfahrt ${fmtHM(l.depart)} ≈ ${fmtDur(l.minutes)}; um ${fmtHM(w.depart)} wären es ≈ ${fmtDur(w.minutes)}.`);
    } else {
      out.push(`${where}: Abfahrt ${fmtHM(l.depart)} ≈ ${fmtDur(l.minutes)}.`);
    }
    if (better.length) {
      const b = better.sort((a, c) => a.minutes - c.minutes)[0];
      const why = b.depart < l.depart ? 'passt nicht zu deinen Terminen bzw. kostet mehr Freizeit' : 'würde mehr Wartezeit bedeuten, die sich nicht lohnt';
      out.push(`  (Um ${fmtHM(b.depart)} ginge es in ≈ ${fmtDur(b.minutes)}, ${why}.)`);
    }
    if (l.wait >= 10 && l.from !== 'home') out.push(`  Bewusst ${fmtDur(l.wait)} später losfahren: der Verkehr lässt dann nach.`);
  }
  return out;
}

export { fmtHM, fmtDur };
