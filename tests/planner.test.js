import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults, buildDay } from '../supabase/functions/pendel/core/schedule.js';
import { planDay } from '../supabase/functions/pendel/core/planner.js';
import { explainPlan } from '../supabase/functions/pendel/core/explain.js';
import { demoTravel } from '../supabase/functions/pendel/core/demo.js';
import { parseHM, zonedToUtc, localParts, minutesOn } from '../supabase/functions/pendel/core/time.js';

const MON = '2026-10-12';
const demo = (date) => (a, b, m) => demoTravel(a, b, date, m, 35);

test('Zeitzone: lokale Minute ↔ UTC (Sommer- und Winterzeit)', () => {
  assert.equal(zonedToUtc('2026-07-01', 450).toISOString(), '2026-07-01T05:30:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', 450).toISOString(), '2026-12-01T06:30:00.000Z');
  const lp = localParts(new Date('2026-10-25T08:00:00Z')); // Tag der Zeitumstellung
  assert.equal(lp.dateStr, '2026-10-25');
  assert.equal(lp.minutes, 540);
  assert.equal(minutesOn('2026-10-25', new Date('2026-10-25T08:00:00Z')), 540);
});

test('8-Stunden-Tag bekommt 30 min Pause (8,5 h vor Ort)', () => {
  const day = buildDay(withDefaults({}), MON);
  assert.equal(day.work.duration, 510);
  const fri = buildDay(withDefaults({}), '2026-10-16');
  assert.equal(fri.work.duration, 240);
});

test('Planer meidet die Rushhour und erfüllt die Arbeitszeit', () => {
  const s = withDefaults({});
  const day = buildDay(s, MON);
  const plan = planDay(day, demo(MON), s);
  const best = plan.scenarios[0];
  assert.ok(best);
  assert.equal(best.work.end - best.work.start, 510);
  assert.equal(best.legs.length, 2);
  // Fahrt kommt rechtzeitig an
  assert.ok(best.legs[0].arrive <= best.work.start);
  assert.ok(best.legs[1].depart >= best.work.end);
  // Morgenspitze (07:50) wird gemieden: Fahrt deutlich kürzer als zur Spitze
  const peak = demoTravel('home', 'work', MON, parseHM('07:50'), 35);
  assert.ok(best.legs[0].minutes < peak - 10, `${best.legs[0].minutes} vs ${peak}`);
  assert.ok(plan.scenarios.length >= 2, 'es gibt Alternativen');
});

test('Pflichtveranstaltung wird nie verpasst, optionale darf weichen', () => {
  const s = withDefaults({
    work: { days: { 0: { hours: 4, earliest: '06:00', latest: '20:00' } } },
    study: [
      { id: 'a', title: 'Mathe', weekday: 0, start: '14:00', end: '15:30', location: 'uni', kind: 'mandatory' },
      { id: 'b', title: 'Tutorium', weekday: 0, start: '16:00', end: '17:30', location: 'uni', kind: 'optional' },
    ],
  });
  const day = buildDay(s, MON);
  const plan = planDay(day, demo(MON), s);
  explainPlan(plan, s);
  for (const sc of plan.scenarios) {
    const m = sc.events.find((e) => e.id === 'a');
    assert.equal(m.attend, 'full');
    // Arbeit überlappt nie mit Mathe
    assert.ok(sc.work.end <= 14 * 60 || sc.work.start >= 15.5 * 60);
  }
  const best = plan.scenarios[0];
  assert.ok(best.steps.length > 0);
  assert.ok(best.summary.includes('los'));
});

test('Höheres Gewicht auf optionale Veranstaltungen → wird besucht', () => {
  const base = {
    work: { days: { 0: { hours: 0 } } },
    study: [{ id: 'b', title: 'Tutorium', weekday: 0, start: '16:00', end: '17:30', location: 'uni', kind: 'optional' }],
  };
  const lazy = withDefaults({ ...base, priorities: { commute: 1, away: 0.35, optionalMissed: 0.05 } });
  const keen = withDefaults({ ...base, priorities: { commute: 1, away: 0.35, optionalMissed: 3 } });
  const p1 = planDay(buildDay(lazy, MON), demo(MON), lazy);
  const p2 = planDay(buildDay(keen, MON), demo(MON), keen);
  assert.equal(p1.scenarios[0].events[0].attend, 'skip');
  assert.equal(p2.scenarios[0].events[0].attend, 'full');
});

test('Am Tag selbst: ab aktuellem Ort und fixer Arbeitsbeginn', () => {
  const s = withDefaults({});
  const day = buildDay(s, MON);
  const plan = planDay(day, demo(MON), s, { nowMin: parseHM('12:00'), state: { location: 'work', availableFrom: 420, workStart: 420 } });
  const best = plan.scenarios[0];
  assert.equal(best.legs.length, 1);
  assert.equal(best.legs[0].to, 'home');
  assert.ok(best.legs[0].depart >= 420 + 510);
});

test('Überlange Wartezeit wird nicht empfohlen, kurzes Warten bei Stau schon', () => {
  const s = withDefaults({});
  // künstlicher Stau direkt nach Feierabend (16:30–17:00), danach frei
  const travel = (a, b, m) => (b === 'home' && m >= 990 && m < 1020 ? 80 : 35);
  const day = buildDay(s, MON);
  const plan = planDay(day, travel, s, { nowMin: 600, state: { location: 'work', availableFrom: 480, workStart: 480 } });
  const leg = plan.scenarios[0].legs[0];
  assert.equal(leg.depart, 1020, 'wartet den Stau ab');
});

test('Verpasste Pflichtveranstaltung: trotzdem Plan + Warnung', () => {
  const s = withDefaults({
    study: [{ id: 'a', title: 'Statistik', weekday: 2, start: '08:15', end: '09:45', location: 'uni', kind: 'mandatory' }],
  });
  const WED = '2026-10-14';
  const plan = planDay(buildDay(s, WED), demo(WED), s, { nowMin: parseHM('07:50') });
  assert.ok(plan.scenarios.length > 0);
  assert.match(plan.warnings[0], /Statistik/);
  const e = plan.scenarios[0].events.find((x) => x.id === 'a');
  assert.ok(e.attend === 'late', 'kommt so früh wie möglich nach');
});
