const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROUTES_FILE = path.join(__dirname, '../../data/apsrtc-routes.json.gz');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Static route catalogue (route numbers, stops, shapes, departures) built from the open APSRTC GTFS feed.
 */
class RouteCatalog {
  constructor() {
    this.routes = [];
    this.byId = new Map();
    this.cities = [];
  }

  load() {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(ROUTES_FILE));
      const data = JSON.parse(raw.toString('utf8'));
      this.routes = (data.routes || []).map(r => ({
        ...r,
        noKey: norm(r.no).replace(/ /g, ''),
        nameKey: norm(r.name)
      }));
      this.byId = new Map(this.routes.map(r => [r.id, r]));
      const counts = new Map();
      for (const r of this.routes) if (r.city) counts.set(r.city, (counts.get(r.city) || 0) + 1);
      this.cities = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, routes]) => ({ name, routes }));
      console.log(`[RouteCatalog] Loaded ${this.routes.length} routes.`);
    } catch (err) {
      console.warn('[RouteCatalog] Route data unavailable (run "npm run build-routes"):', err.message);
    }
  }

  summary(r) {
    return { id: r.id, no: r.no, name: r.name, kind: r.kind, type: r.type, city: r.city, trips: r.trips, stopCount: r.stops.length };
  }

  /**
   * Search by route number or by any words of the route / stop names.
   * Exact number matches rank first, then number prefixes, then name matches.
   */
  search(query = '', { city = '', kind = '', limit = 40 } = {}) {
    const q = norm(query);
    const qNo = q.replace(/ /g, '');
    const tokens = q.split(' ').filter(Boolean);
    const cityKey = city.toLowerCase();
    const kindKey = kind.toLowerCase();
    const scored = [];

    for (const r of this.routes) {
      if (cityKey && r.city.toLowerCase() !== cityKey) continue;
      if (kindKey && r.kind.toLowerCase() !== kindKey) continue;
      let score = 0;
      if (!q) score = r.kind === 'City' ? 2 : 1;
      else if (r.noKey === qNo) score = 100;
      else if (r.noKey.startsWith(qNo)) score = 60;
      else if (tokens.every(t => r.nameKey.includes(t))) score = 40;
      else if (tokens.every(t => r.nameKey.includes(t) || r.stops.some(s => norm(s[0]).includes(t)))) score = 20;
      if (score) scored.push([score + (r.city ? 5 : 0), r]);
    }

    scored.sort((a, b) => b[0] - a[0] || b[1].trips - a[1].trips || a[1].no.localeCompare(b[1].no, undefined, { numeric: true }));
    return { total: scored.length, routes: scored.slice(0, limit).map(([, r]) => this.summary(r)) };
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /**
   * Live buses running this route: same route number as the OPRS prefix, then narrowed
   * by matching origin/destination words when that leaves at least one bus.
   */
  matchLiveBuses(route, buses) {
    const byNumber = buses.filter(b => norm((b.oprsNo || '').split('-')[0]).replace(/ /g, '') === route.noKey);
    if (!byNumber.length) return [];
    const ends = [route.stops[0]?.[0], route.stops[route.stops.length - 1]?.[0]]
      .map(n => norm(n).split(' ').find(w => w.length >= 4))
      .filter(Boolean);
    const narrowed = byNumber.filter(b => {
      const text = norm(`${b.sourceName} ${b.destinationName} ${b.routeName}`);
      return ends.some(w => text.includes(w));
    });
    return narrowed.length ? narrowed : byNumber;
  }
}

module.exports = new RouteCatalog();
