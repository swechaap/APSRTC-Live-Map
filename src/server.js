const fs = require('fs');
const path = require('path');

// Load environment variables locally from .env if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    });
  } catch (e) {
    console.warn('Could not read .env file:', e.message);
  }
}

const http = require('http');

const busTracker = require('./services/busTracker');
const routeCatalog = require('./services/routeCatalog');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: ensure inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Favicon fallback: if /favicon.ico is requested and doesn't exist, serve favicon.svg
  if (pathname === '/favicon.ico' && !fs.existsSync(filePath)) {
    const svgPath = path.join(PUBLIC_DIR, 'favicon.svg');
    if (fs.existsSync(svgPath)) {
      filePath = svgPath;
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const query = Object.fromEntries(reqUrl.searchParams.entries());

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // API Endpoints
    // CARTO Map Configuration
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        success: true,
        cartoApiKey: process.env.CARTO_API_KEY || ''
      });
    }

    if (pathname === '/api/buses/live' && req.method === 'GET') {
      let buses = busTracker.getActiveBuses();

      // Optional filtering / searching
      if (query.docId) {
        const found = await busTracker.findOrFetchBus(query.docId);
        buses = found ? [found] : [];
      } else if (query.search) {
        buses = await busTracker.searchBuses(query.search);
      } else if (query.depot) {
        buses = await busTracker.fetchBusesByDepot(query.depot);
      }

      if (query.type) {
        buses = buses.filter(b => b.serviceType && b.serviceType.toLowerCase() === query.type.toLowerCase());
      }

      return sendJson(res, 200, {
        success: true,
        count: buses.length,
        lastSync: busTracker.lastSync,
        filters: busTracker.getKnownFilters(),
        buses
      });
    }

    if (pathname === '/api/stops' && req.method === 'GET') {
      const search = (query.search || '').trim();
      if (search.length < 2) {
        return sendJson(res, 400, { success: false, error: 'Enter at least 2 characters' });
      }
      return sendJson(res, 200, { success: true, stops: busTracker.searchStops(search) });
    }

    if (pathname === '/api/routes' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 100);
      const result = routeCatalog.search(query.q || '', { city: query.city || '', kind: query.kind || '', limit });
      return sendJson(res, 200, { success: true, cities: routeCatalog.cities, ...result });
    }

    if (pathname === '/api/routes/detail' && req.method === 'GET') {
      const route = routeCatalog.get(query.id || '');
      if (!route) return sendJson(res, 404, { success: false, error: 'Route not found' });
      const { noKey, nameKey, ...detail } = route;
      return sendJson(res, 200, {
        success: true,
        route: detail,
        liveBuses: routeCatalog.matchLiveBuses(route, busTracker.getActiveBuses())
      });
    }

    if (pathname === '/api/stops/nearby' && req.method === 'GET') {
      const lat = Number(query.lat);
      const lng = Number(query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return sendJson(res, 400, { success: false, error: 'Invalid location' });
      }
      return sendJson(res, 200, { success: true, stops: busTracker.nearbyStops(lat, lng) });
    }

    if (pathname === '/api/stops/buses' && req.method === 'GET') {
      const buses = busTracker.getStopBuses(query.id || '');
      if (!buses) return sendJson(res, 400, { success: false, error: 'Select a valid stop' });
      return sendJson(res, 200, { success: true, count: buses.length, buses });
    }

    if (pathname === '/api/buses/between' && req.method === 'GET') {
      const buses = busTracker.getBusesBetweenStops(query.from || '', query.to || '');
      if (!buses) return sendJson(res, 400, { success: false, error: 'Select two different valid stops' });
      return sendJson(res, 200, { success: true, count: buses.length, buses });
    }

    if (pathname === '/api/buses/stats' && req.method === 'GET') {
      const stats = busTracker.getStats();
      return sendJson(res, 200, { success: true, stats });
    }

    if (pathname === '/api/buses/geojson' && req.method === 'GET') {
      const geojson = busTracker.toGeoJSON();
      return sendJson(res, 200, geojson);
    }

    if ((pathname === '/api/buses/track' || pathname === '/api/buses/live-location') && req.method === 'GET') {
      const docId = query.docId;
      if (!docId) {
        return sendJson(res, 400, { success: false, error: 'Missing docId query parameter' });
      }
      const live = await busTracker.getLiveBusLocation(docId);
      if (!live) {
        return sendJson(res, 404, { success: false, error: 'Live GPS location not currently available for this bus' });
      }
      return sendJson(res, 200, { success: true, live });
    }

    if (pathname === '/api/buses/route' && req.method === 'GET') {
      const docId = query.docId;
      if (!docId) {
        return sendJson(res, 400, { success: false, error: 'Missing docId query parameter' });
      }
      const routeDetails = await busTracker.getBusRouteDetails(docId);
      return sendJson(res, 200, { success: true, route: routeDetails });
    }

    if (pathname === '/api/buses/refresh' && req.method === 'POST') {
      const buses = await busTracker.syncActiveBuses(true);
      return sendJson(res, 200, { success: true, count: buses.length, message: 'Refreshed active buses' });
    }

    // Serve Frontend Static Files
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('Server error handling request:', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
});

async function main() {
  try {
    console.log('====================================================');
    console.log('   APSRTC Live Bus Tracker — Starting Server');
    console.log('====================================================');
    routeCatalog.load();
    await busTracker.init();
    busTracker.startPolling(25000); // Poll every 25 seconds

    server.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
      console.log(`Open http://localhost:${PORT} in your browser to view the live bus map.`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

console.log(
    process.env.CARTO_API_KEY
        ? 'CARTO API key loaded successfully'
        : 'CARTO API key not set (map will use keyless tiles)'
);

main();