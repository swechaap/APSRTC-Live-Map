#!/usr/bin/env node
/**
 * Builds data/apsrtc-routes.json.gz from the open APSRTC GTFS feed
 * (https://github.com/reclaimchennai/apsrtc, ODbL).
 *
 * Usage:
 *   curl -L -o /tmp/apsrtc-gtfs.zip https://github.com/reclaimchennai/apsrtc/raw/main/data/apsrtc-gtfs.zip
 *   unzip -o /tmp/apsrtc-gtfs.zip -d /tmp/apsrtc-gtfs
 *   npm run build-routes -- /tmp/apsrtc-gtfs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/build-routes.js <unzipped-gtfs-dir>');
  process.exit(1);
}

const OUT = path.join(__dirname, '../data/apsrtc-routes.json.gz');
const MAX_DEPARTURES = 60;
const SHAPE_TOLERANCE = 0.0003; // ~30 m

// Approximate city centres, used to tag City-type routes
const CITIES = [
  ['Visakhapatnam', 17.7231, 83.3013],
  ['Vijayawada', 16.5062, 80.648],
  ['Guntur', 16.3067, 80.4365],
  ['Tirupati', 13.6288, 79.4192],
  ['Nellore', 14.4426, 79.9865],
  ['Kakinada', 16.9891, 82.2475],
  ['Rajahmundry', 17.0005, 81.804],
  ['Kurnool', 15.8281, 78.0373],
  ['Anantapur', 14.6819, 77.6006],
  ['Kadapa', 14.4673, 78.8242],
  ['Eluru', 16.7107, 81.0952],
  ['Ongole', 15.5057, 80.0499],
  ['Machilipatnam', 16.1875, 81.1389],
  ['Srikakulam', 18.2949, 83.8938],
  ['Vizianagaram', 18.1067, 83.3956],
  ['Chittoor', 13.2172, 79.1003],
  ['Amaravati', 16.5731, 80.3577]
];

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    fn(row);
  }
}

// Douglas-Peucker line simplification
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const [ay, ax] = points[a];
    const [by, bx] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = points[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx !== -1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function nearestCity(lat, lng) {
  let best = null;
  let bestKm = Infinity;
  for (const [name, clat, clng] of CITIES) {
    const km = Math.hypot((lat - clat) * 111, (lng - clng) * 111 * Math.cos(clat * Math.PI / 180));
    if (km < bestKm) { bestKm = km; best = name; }
  }
  return bestKm <= 35 ? best : '';
}

const hhmm = t => (t || '').slice(0, 5);

(async () => {
  const routes = new Map();
  await eachRow('routes.txt', r => {
    const [kind, ...rest] = (r.route_desc || '').split(' · ');
    routes.set(r.route_id, {
      id: r.route_id,
      no: r.route_short_name,
      name: r.route_long_name,
      kind: kind || 'Intercity',
      type: rest[0] || '',
      trips: 0,
      repTrip: null,
      shapeId: null,
      deps: new Set()
    });
  });

  const tripToRoute = new Map();
  await eachRow('trips.txt', t => {
    const route = routes.get(t.route_id);
    if (!route) return;
    route.trips++;
    tripToRoute.set(t.trip_id, route);
    if (!route.repTrip) { route.repTrip = t.trip_id; route.shapeId = t.shape_id; }
  });

  const stops = new Map();
  await eachRow('stops.txt', s => stops.set(s.stop_id, [s.stop_name, +s.stop_lat, +s.stop_lon]));

  // Collect each trip's first departure and the stops of each route's representative trip
  const repStops = new Map();
  const seenFirst = new Set();
  await eachRow('stop_times.txt', st => {
    const route = tripToRoute.get(st.trip_id);
    if (!route) return;
    if (!seenFirst.has(st.trip_id)) {
      seenFirst.add(st.trip_id);
      route.deps.add(hhmm(st.departure_time));
    }
    if (st.trip_id === route.repTrip) {
      if (!repStops.has(route.id)) repStops.set(route.id, []);
      const s = stops.get(st.stop_id);
      if (s) repStops.get(route.id).push([+st.stop_sequence, hhmm(st.arrival_time), s]);
    }
  });

  const neededShapes = new Set([...routes.values()].map(r => r.shapeId).filter(Boolean));
  const shapes = new Map();
  await eachRow('shapes.txt', p => {
    if (!neededShapes.has(p.shape_id)) return;
    if (!shapes.has(p.shape_id)) shapes.set(p.shape_id, []);
    shapes.get(p.shape_id).push([+p.shape_pt_sequence, +p.shape_pt_lat, +p.shape_pt_lon]);
  });

  const simplified = new Map();
  const shapeFor = id => {
    if (!simplified.has(id)) {
      const pts = (shapes.get(id) || []).sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
      simplified.set(id, simplify(pts, SHAPE_TOLERANCE).map(([la, ln]) => [+la.toFixed(5), +ln.toFixed(5)]));
    }
    return simplified.get(id);
  };

  const out = [];
  for (const r of routes.values()) {
    const rs = (repStops.get(r.id) || []).sort((a, b) => a[0] - b[0]);
    if (!rs.length) continue;
    const routeStops = rs.map(([, time, [name, lat, lng]]) => [name, +lat.toFixed(5), +lng.toFixed(5), time]);
    const mid = routeStops[Math.floor(routeStops.length / 2)];
    out.push({
      id: r.id,
      no: r.no,
      name: r.name,
      kind: r.kind,
      type: r.type,
      city: r.kind === 'City' ? nearestCity(mid[1], mid[2]) : '',
      trips: r.trips,
      deps: [...r.deps].sort().slice(0, MAX_DEPARTURES),
      stops: routeStops,
      shape: shapeFor(r.shapeId)
    });
  }

  const payload = { source: 'reclaimchennai/apsrtc GTFS (ODbL)', generatedAt: new Date().toISOString(), routes: out };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(payload), { level: 9 }));
  const cityCounts = {};
  out.forEach(r => { if (r.city) cityCounts[r.city] = (cityCounts[r.city] || 0) + 1; });
  console.log(`Wrote ${out.length} routes to ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
  console.log('City routes:', cityCounts);
})();
