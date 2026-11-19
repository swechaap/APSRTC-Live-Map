const dotenv = require('dotenv');
const path = require('path');

// Load environment variables first (locally from .env; on Render from the Environment tab)
dotenv.config({
    path: path.resolve(__dirname, '../.env')
});

const http = require('http');
const fs = require('fs');

const busTracker = require('./services/busTracker');

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
    // Returns an empty key (instead of an error) when CARTO_API_KEY is not set,
    // because CARTO Voyager tiles also work without a key.
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
        buses
      });
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