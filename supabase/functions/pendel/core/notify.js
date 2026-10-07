// Entscheidet, wann welche Nachricht verschickt wird – ohne zu nerven und
// ohne mitten in einer Vorlesung „jetzt losfahren“ zu sagen.
import { parseHM, fmtHM, fmtDur, WEEKDAYS } from './time.js';
import { placeName } from './explain.js';

export const legKey = (l, i) => `${l.from}>${l.to}#${i}`;

function inQuiet(nowMin, n) {
  const qs = parseHM(n.quietStart), qe = parseHM(n.quietEnd);
  if (qs == null || qe == null) return false;
  return qs > qe ? nowMin >= qs || nowMin < qe : nowMin >= qs && nowMin < qe;
}

/** Laufende Termine (Vorlesung/Termin), in denen nichts gestört werden soll. */
function busyAt(best, m) {
  return (best?.events || []).find((e) => e.attend !== 'skip' && (e.attendStart ?? e.start) <= m && m < (e.attendEnd ?? e.end));
}

/**
 * @param ctx { nowMin, today, tomorrow, todayPlan, tomorrowPlan, settings, sent: [{key, payload}] }
 * @returns [{ key, title, message, priority, payload }]
 */
export function decideNotifications(ctx) {
  const { nowMin, today, tomorrow, todayPlan, tomorrowPlan, settings } = ctx;
  const n = settings.notify;
  const lead = n.leadMin ?? 15;
  const thr = n.changeThresholdMin ?? 5;
  const sentKeys = new Set(ctx.sent.map((s) => s.key));
  const out = [];
  const quiet = inQuiet(nowMin, n);

  // 1) Vorabend-Prognose für morgen
  const tBest = tomorrowPlan?.scenarios?.[0];
  if (tBest && tBest.legs.length && nowMin >= parseHM(n.eveningTime) && !quiet && !sentKeys.has(`evening:${tomorrow}`)) {
    const l0 = tBest.legs[0];
    const wd = WEEKDAYS[tomorrowPlan.weekday ?? 0] || 'Morgen';
    const lines = [`Beste Abfahrt voraussichtlich ${fmtHM(l0.depart)} (an ${fmtHM(l0.arrive)}).`];
    if (tBest.work) lines.push(`Arbeit ${fmtHM(tBest.work.start)}–${fmtHM(tBest.work.end)}.`);
    const last = tBest.legs[tBest.legs.length - 1];
    if (last !== l0) lines.push(`Heimfahrt ${fmtHM(last.depart)}, zu Hause ca. ${fmtHM(last.arrive)}.`);
    lines.push(`Pendelzeit ≈ ${fmtDur(tBest.totals.commute)}. Ich prüfe morgen früh nochmal.`);
    out.push({
      key: `evening:${tomorrow}`, title: `Morgen (${wd}): ${fmtHM(l0.depart)} losfahren`, message: lines.join(' '), priority: 3,
      payload: { date: tomorrow, departs: Object.fromEntries(tBest.legs.map((l, i) => [legKey(l, i), l.depart])) },
    });
  }

  const best = todayPlan?.scenarios?.[0];
  if (!best) return out;
  const lastSentDepart = (lk) => {
    let v = null;
    for (const s of ctx.sent) {
      if (s.payload?.date !== today) continue;
      if (s.payload?.departs?.[lk] != null) v = s.payload.departs[lk];
    }
    return v;
  };

  // Nur die nächste anstehende Fahrt zählt für Aktualisierungen/Losfahr-Hinweise
  const idx = best.legs.findIndex((l) => l.depart >= nowMin - 5);
  if (idx < 0) return out;
  const leg = best.legs[idx];
  const lk = legKey(leg, idx);
  const where = `${placeName(settings, leg.from)} → ${placeName(settings, leg.to)}`;

  // 2) Losfahr-Hinweis
  let notifyAt = leg.depart - lead;
  const busy = busyAt(best, notifyAt);
  let busyNote = null;
  if (busy && (busy.attendEnd ?? busy.end) <= leg.depart) {
    notifyAt = (busy.attendStart ?? busy.start) - 5;
    busyNote = busy;
  }
  if (nowMin >= notifyAt && nowMin <= leg.depart + 5 && !sentKeys.has(`lead:${today}:${lk}`)) {
    const inMin = Math.round(leg.depart - nowMin);
    const title = busyNote
      ? `Nach „${busyNote.title}“ direkt los: ${fmtHM(leg.depart)}`
      : inMin > 1 ? `In ${inMin} Minuten losfahren (${fmtHM(leg.depart)})` : `Jetzt losfahren`;
    out.push({
      key: `lead:${today}:${lk}`, title,
      message: `${where}: aktuell beste Option. Fahrzeit ≈ ${fmtDur(leg.minutes)}, Ankunft ca. ${fmtHM(leg.arrive)}.`
        + (best.work && leg.to === settings.work.location ? ` Feierabend dann ${fmtHM(best.work.end)}.` : ''),
      priority: 4,
      payload: { date: today, departs: { [lk]: leg.depart } },
    });
    return out;
  }

  // 3) Aktualisierung, wenn sich die beste Zeit spürbar verschoben hat
  const prev = lastSentDepart(lk);
  const inside = busyAt(best, nowMin);
  if (!quiet && !inside && leg.depart - nowMin > lead + 5) {
    if (prev == null) {
      if (!sentKeys.has(`morning:${today}`) && !sentKeys.has(`evening:${today}`) && leg.depart - nowMin < 6 * 60) {
        out.push({
          key: `morning:${today}`, title: `Heute: ${fmtHM(leg.depart)} losfahren`,
          message: `${best.summary || ''}`.trim(), priority: 3,
          payload: { date: today, departs: { [lk]: leg.depart } },
        });
      }
    } else if (Math.abs(leg.depart - prev) >= thr) {
      const key = `update:${today}:${lk}:${leg.depart}`;
      if (!sentKeys.has(key)) {
        out.push({
          key, title: `Aktuell sieht ${fmtHM(leg.depart)} besser aus`,
          message: `${where}: statt ${fmtHM(prev)} jetzt ${fmtHM(leg.depart)} (≈ ${fmtDur(leg.minutes)}, an ${fmtHM(leg.arrive)}). Grund: aktuelle Verkehrslage.`,
          priority: 3,
          payload: { date: today, departs: { [lk]: leg.depart } },
        });
      }
    }
  }
  return out;
}
