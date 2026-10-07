// Lokaler Testserver: App + Backend im Demo-Modus (Daten nur im Arbeitsspeicher).
// Start: npm run dev  →  http://localhost:8787/#api=http://localhost:8787/api&token=dev
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createApp } from '../supabase/functions/pendel/server.js';
import { memoryStore } from '../supabase/functions/pendel/store_memory.js';

const root = new URL('../web/', import.meta.url).pathname;
const store = memoryStore({
  settings: {
    locations: {
      home: { label: 'Zuhause', address: 'Beispielstraße 1', lat: 50.8, lon: 7.2 },
      work: { label: 'Arbeit', address: 'Firmenweg 2', lat: 50.94, lon: 6.96 },
      uni: { label: 'Uni', address: 'Campus 3', lat: 50.73, lon: 7.1 },
    },
    study: [
      { id: 'st1', title: 'Statistik', weekday: 2, start: '08:15', end: '09:45', location: 'uni', kind: 'mandatory' },
      { id: 'st2', title: 'Tutorium BWL', weekday: 2, start: '16:00', end: '17:30', location: 'uni', kind: 'optional' },
      { id: 'st3', title: 'Recht', weekday: 3, start: '18:00', end: '19:30', location: 'uni', kind: 'optional' },
    ],
  },
});
const app = createApp({ store, log: () => {} });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const fakeNow = process.env.NOW ? new Date(process.env.NOW) : null;
const now = () => fakeNow || new Date();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice(4);
      const body = req.method === 'GET' ? {} : await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
      const out = await ({
        'GET /overview': () => app.overview(now()),
        'GET /settings': () => app.settings(),
        'PUT /settings': () => app.saveSettings(body),
        'POST /state': () => app.setState(body, now()),
        'GET /stats': () => app.stats(now()),
        'POST /tick': () => app.tick(now()),
        'GET /plan': () => app.planFor(url.searchParams.get('date'), now()),
        'GET /geocode': async () => ({ lat: 50.9, lon: 7.0, address: `${url.searchParams.get('q')} (Demo)` }),
        'POST /test-notification': async () => ({ ok: true }),
      }[`${req.method} ${path}`] || (() => { throw new Error('404'); }))();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(root)) throw new Error('404');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(e.message === '404' ? 404 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(process.env.PORT || 8787, () => console.log(`http://localhost:${process.env.PORT || 8787}/#api=http://localhost:${process.env.PORT || 8787}/api&token=dev`));
