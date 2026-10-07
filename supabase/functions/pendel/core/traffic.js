// Fahrzeit-Modell. Kombiniert drei Quellen:
//  1. Prognose des Verkehrsdienstes für den Zieltag ("forecast")
//  2. Eigene Erfahrungswerte aus vergangenen Tagen ("live"/"trip"), gleicher Wochentag
//  3. Aktuelle Verkehrslage am Tag selbst, die die Prognose für die nächsten Stunden korrigiert
// Zusätzlich lernt es, wie stark die Prognosen des Dienstes typischerweise danebenliegen (bias).
import { weekdayOf, minutesOn, daysBetween, localParts } from './time.js';
import { demoTravel } from './demo.js';

const BUCKET = 15;

/**
 * @param observations [{origin, dest, depart_at, minutes, source, fetched_at}]
 * @param date         Zieltag 'YYYY-MM-DD'
 * @param now          Date (für Live-Korrektur am selben Tag)
 */
export function buildTravelModel({ observations, date, now, settings }) {
  const base = settings?.planning?.baseTravelMin ?? 35;
  const weekday = weekdayOf(date);
  const nowParts = now ? localParts(now) : null;
  const isToday = nowParts?.dateStr === date;
  const nowMin = isToday ? nowParts.minutes : null;

  const byPair = new Map();
  for (const o of observations || []) {
    const k = `${o.origin}>${o.dest}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(o);
  }
  const pairs = new Map();
  const pairModel = (from, to) => {
    const k = `${from}>${to}`;
    if (!pairs.has(k)) pairs.set(k, makePair(byPair.get(k) || [], from, to));
    return pairs.get(k);
  };

  function makePair(obs, from, to) {
    // 1) Prognosepunkte für den Zieltag (jeweils die neueste Abfrage pro Abfahrtszeit)
    const fc = new Map();
    for (const o of obs) {
      if (o.source !== 'forecast') continue;
      const dep = new Date(o.depart_at);
      if (localParts(dep).dateStr !== date) continue;
      const m = Math.round(minutesOn(date, dep));
      const prev = fc.get(m);
      if (!prev || new Date(o.fetched_at) > new Date(prev.fetched_at)) fc.set(m, o);
    }
    const forecastPts = [...fc.entries()].map(([m, o]) => [m, Number(o.minutes)]).sort((a, b) => a[0] - b[0]);

    // 2) Erfahrungswerte: gleiche Wochentage der letzten 10 Wochen, neuere zählen mehr
    const actual = obs.filter((o) => o.source === 'live' || o.source === 'trip');
    const buckets = new Map();
    const sameType = (wd) => (weekday <= 4 ? wd <= 4 : wd >= 5);
    for (const o of actual) {
      const dep = new Date(o.depart_at);
      const lp = localParts(dep);
      if (lp.dateStr >= date) continue;
      const ageDays = daysBetween(lp.dateStr, date);
      if (ageDays > 70) continue;
      let w = Math.pow(0.5, ageDays / 28);
      if (lp.weekday === weekday) w *= 1;
      else if (sameType(lp.weekday)) w *= 0.25;
      else continue;
      if (o.source === 'trip') w *= 1.5;
      const b = Math.floor(lp.minutes / BUCKET);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push([Number(o.minutes), w]);
    }
    const learnedPts = [...buckets.entries()]
      .map(([b, arr]) => [b * BUCKET + BUCKET / 2, weightedMedian(arr), arr.reduce((s, x) => s + x[1], 0)])
      .sort((a, b) => a[0] - b[0]);

    // 3) Bias: echte Fahrzeit / damalige Prognose des Dienstes (beim Messen gespeichert)
    const ratios = [];
    for (const a of actual) if (a.ref_forecast > 0) ratios.push(Number(a.minutes) / Number(a.ref_forecast));
    const bias = ratios.length >= 4 ? clamp(median(ratios), 0.8, 1.4) : 1;

    const baseAt = (m) => {
      const f = interp(forecastPts, m, 75);
      const l = interpW(learnedPts, m, 45);
      if (f != null && l) {
        const w = Math.min(0.6, l.w / 6);
        return (1 - w) * f * bias + w * l.v;
      }
      if (f != null) return f * bias;
      if (l) return l.v;
      return null;
    };

    // 4) Live-Korrektur: aktuelle Messung (max. 20 min alt) vs. Basis-Erwartung für jetzt
    let liveRatio = 1;
    if (isToday && now) {
      const recent = actual
        .filter((o) => o.source === 'live' && now - new Date(o.fetched_at) < 20 * 60000)
        .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))[0];
      if (recent) {
        const m = minutesOn(date, new Date(recent.depart_at));
        const exp = baseAt(m) ?? demoTravel(from, to, date, m, base);
        if (exp > 0) liveRatio = clamp(Number(recent.minutes) / exp, 0.6, 2.5);
      }
    }

    const sources = { forecast: forecastPts.length, learned: learnedPts.length, bias, liveRatio };
    const at = (m) => {
      let v = baseAt(m);
      const src = v == null ? 'standard' : 'daten';
      if (v == null) v = demoTravel(from, to, date, m, base);
      if (liveRatio !== 1 && nowMin != null && m >= nowMin - 30) {
        v *= 1 + (liveRatio - 1) * Math.exp(-Math.max(0, m - nowMin) / 60);
      }
      return { minutes: v, src };
    };
    return { at, sources, forecastPts, learnedPts };
  }

  const travel = (from, to, m) => pairModel(from, to).at(m).minutes;
  travel.info = (from, to) => pairModel(from, to).sources;
  travel.curve = (from, to, startMin = 300, endMin = 1260, step = 10) => {
    const p = pairModel(from, to);
    const pts = [];
    for (let m = startMin; m <= endMin; m += step) pts.push([m, Math.round(p.at(m).minutes * 10) / 10]);
    return { points: pts, forecast: p.forecastPts, learned: p.learnedPts.map(([m, v]) => [m, Math.round(v * 10) / 10]), sources: p.sources };
  };
  return travel;
}

function interp(pts, m, maxGap) {
  if (!pts.length) return null;
  if (m <= pts[0][0]) return pts[0][0] - m <= maxGap ? pts[0][1] : null;
  const last = pts[pts.length - 1];
  if (m >= last[0]) return m - last[0] <= maxGap ? last[1] : null;
  for (let i = 1; i < pts.length; i++) {
    const [m1, v1] = pts[i];
    if (m <= m1) {
      const [m0, v0] = pts[i - 1];
      if (m1 - m0 > 2 * maxGap) return Math.min(m - m0, m1 - m) <= maxGap ? (m - m0 < m1 - m ? v0 : v1) : null;
      return v0 + ((v1 - v0) * (m - m0)) / (m1 - m0);
    }
  }
  return null;
}

function interpW(pts, m, maxGap) {
  const near = pts.filter((p) => Math.abs(p[0] - m) <= maxGap);
  if (!near.length) return null;
  let sw = 0, sv = 0, n = 0;
  for (const [pm, v, w] of near) {
    const k = w * (1 - Math.abs(pm - m) / (maxGap + 1));
    sw += k; sv += k * v; n += w;
  }
  return sw > 0 ? { v: sv / sw, w: n } : null;
}

export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
}

function weightedMedian(arr) {
  const s = [...arr].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((x, y) => x + y[1], 0);
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= total / 2) return v; }
  return s[s.length - 1][0];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
