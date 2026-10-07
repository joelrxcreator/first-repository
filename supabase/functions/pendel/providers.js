// Externe Dienste: TomTom (Verkehr, Adresssuche) und ntfy (Push-Nachrichten).
import { localParts, tzOffsetMin } from './core/time.js';

function rfc3339Local(date) {
  const off = tzOffsetMin(date);
  const lp = localParts(date);
  const m = Math.floor(lp.minutes);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  const sign = off >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const om = String(Math.abs(off) % 60).padStart(2, '0');
  return `${lp.dateStr}T${hh}:${mm}:00${sign}${oh}:${om}`;
}

export function tomtomProvider(key, locations, fetchImpl = fetch) {
  return {
    name: 'tomtom',
    /** Fahrzeit in Minuten. depart = Date in der Zukunft oder 'now'. */
    async route(from, to, depart) {
      const a = locations[from], b = locations[to];
      if (!a?.lat || !b?.lat) throw new Error(`Ort ohne Koordinaten: ${!a?.lat ? from : to}`);
      const dep = depart === 'now' ? 'now' : encodeURIComponent(rfc3339Local(depart));
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${a.lat},${a.lon}:${b.lat},${b.lon}/json`
        + `?key=${encodeURIComponent(key)}&traffic=true&travelMode=car&routeType=fastest&departAt=${dep}`;
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error(`TomTom ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return j.routes[0].summary.travelTimeInSeconds / 60;
    },
  };
}

export async function tomtomGeocode(key, query, fetchImpl = fetch) {
  const url = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(query)}.json`
    + `?key=${encodeURIComponent(key)}&limit=1&language=de-DE&countrySet=DE,AT,CH`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`TomTom ${r.status}`);
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) return null;
  return { lat: hit.position.lat, lon: hit.position.lon, address: hit.address?.freeformAddress || query };
}

export async function sendNtfy(topic, { title, message, priority = 3, click }, fetchImpl = fetch) {
  if (!topic) return false;
  const r = await fetchImpl('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, priority, tags: ['car'], ...(click ? { click } : {}) }),
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  return true;
}
