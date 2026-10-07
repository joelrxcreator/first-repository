// Plausibles Standard-Verkehrsmuster für ~40 km Pendelstrecke. Wird genutzt,
// solange keine echten Verkehrsdaten vorliegen (Demo-Modus oder Lücken).
import { weekdayOf } from './time.js';

const g = (m, mu, sd) => Math.exp(-((m - mu) ** 2) / (2 * sd * sd));

export function demoTravel(from, to, dateStr, m, base = 35) {
  const wd = weekdayOf(dateStr);
  if (wd >= 5) return base * (1 + 0.08 * g(m, 13 * 60, 120));
  const towardsWork = to !== 'home';
  const fri = wd === 4;
  const morning = (towardsWork ? 0.62 : 0.22) * (fri ? 0.75 : 1) * g(m, 7 * 60 + 50, 38);
  const evening = (towardsWork ? 0.25 : 0.7) * g(m, fri ? 14 * 60 + 45 : 16 * 60 + 50, fri ? 70 : 55);
  const midday = 0.1 * g(m, 12 * 60 + 30, 60);
  const noise = 0.03 * Math.sin((m / 37) + wd * 1.7 + (to.length * 3 + from.length));
  return base * (1 + morning + evening + midday + noise);
}
