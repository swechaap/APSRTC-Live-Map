const fs = require('fs');
const path = require('path');
const {
  fetchServiceDetails,
  fetchServiceWaypointDetails,
  fetchActiveTrips,
  searchBusTracking,
  fetchLiveBusLocation,
  getApsrtcDates
} = require('./apsrtcApi');

/**
 * Sanitizes strings for safe, descriptive filenames
 */
function sanitizeFileNamePart(str) {
  if (!str) return 'UNKNOWN';
  return String(str)
    .trim()
    .replace(/[\/\\]/g, '-')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Maps serviceType to hex color code
 */
function getServiceColor(serviceType) {
  const st = (serviceType || '').toLowerCase();
  if (st.includes('metro express')) return '#2563eb'; // Blue
  if (st.includes('city ordinary') || st.includes('ordinary')) return '#dc2626'; // Red
  if (st.includes('palle') || st.includes('velugu')) return '#16a34a'; // Green
  if (st.includes('super luxury')) return '#7c3aed'; // Purple
  if (st.includes('ultra deluxe')) return '#0891b2'; // Teal
  if (st.includes('green saptagiri') || st.includes('ev')) return '#059669'; // Emerald
  if (st.includes('saptagiri')) return '#ca8a04'; // Yellow
  if (st.includes('indra')) return '#0284c7'; // Sky Blue
  if (st.includes('amaravathi') || st.includes('dolphin') || st.includes('garuda') || st.includes('multiaxle')) return '#b45309'; // Gold
  if (st.includes('metro luxury') || st.includes('aero')) return '#4f46e5'; // Indigo
  if (st.includes('express')) return '#ea580c'; // Orange
  return '#64748b'; // Slate
}

/**
 * Maps serviceType to OSM service classification
 */
function getOsmServiceCategory(serviceType) {
  const st = (serviceType || '').toLowerCase();
  if (st.includes('city') || st.includes('metro')) return 'city';
  if (st.includes('express') || st.includes('luxury') || st.includes('deluxe') || st.includes('indra') || st.includes('amaravathi')) return 'regional';
  if (st.includes('palle') || st.includes('velugu')) return 'rural';
  return 'bus';
}

/**
 * Formats route into standard GeoJSON with OSM PTv2 tags
 */
function toGeoJson(routeData) {
  const { details, stops, polyline } = routeData;

  const osmRef = details.oprsNo || details.routeName || details.serviceDocId;
  const osmName = `Bus ${osmRef}: ${details.sourceName} => ${details.destinationName}`;
  const colour = getServiceColor(details.serviceType);
  const serviceCat = getOsmServiceCategory(details.serviceType);

  const osmRelationTags = {
    'type': 'route',
    'route': 'bus',
    'name': osmName,
    'ref': osmRef,
    'route_ref': details.routeName || '',
    'operator': 'APSRTC',
    'network': 'APSRTC',
    'network:wikidata': 'Q4653664',
    'from': details.sourceName,
    'to': details.destinationName,
    'service': serviceCat,
    'colour': colour,
    'public_transport:version': '2',
    'roundtrip': 'no',
    'source': 'APSRTC Live Track'
  };

  const lineFeature = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: polyline.map(([lat, lng]) => [lng, lat]) // GeoJSON is [lng, lat]
    },
    properties: {
      role: 'route',
      name: `${details.sourceName} -> ${details.destinationName}`,
      serviceType: details.serviceType,
      oprsNo: details.oprsNo,
      depot: details.depotName,
      totalStops: stops.length,
      osm_relation_tags: osmRelationTags
    }
  };

  const stopFeatures = stops.map(stop => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [stop.lng, stop.lat] // [lng, lat]
    },
    properties: {
      role: 'platform',
      seq: stop.seqNo,
      name: stop.name,
      placeCode: stop.placeCode || '',
      placeId: String(stop.placeId || ''),
      scheduledDepTime: stop.scheduleTime || '',
      vtsArrivalTime: stop.vtsArrivalTime || null,
      vtsDepartureTime: stop.vtsDepartureTime || null,
      osm_tags: {
        'highway': 'bus_stop',
        'public_transport': 'platform',
        'bus': 'yes',
        'name': stop.name,
        'ref': stop.placeCode || '',
        'operator': 'APSRTC',
        'network': 'APSRTC'
      }
    }
  }));

  return {
    type: 'FeatureCollection',
    properties: {
      metadata: {
        serviceDocId: details.serviceDocId,
        serviceType: details.serviceType,
        oprsNo: details.oprsNo,
        routeName: details.routeName,
        depotName: details.depotName,
        sourceName: details.sourceName,
        destinationName: details.destinationName,
        startTime: details.startTime,
        endTime: details.endTime,
        driverName: details.driverName,
        driverMobile: details.driverMobile,
        vehicleNumber: details.busNo,
        totalStops: stops.length,
        exportedAt: new Date().toISOString()
      },
      osm_relation_tags: osmRelationTags
    },
    features: [lineFeature, ...stopFeatures]
  };
}

/**
 * Formats route into GPX 1.1 XML with waypoints (<wpt>) and track (<trk>)
 * Directly drag-and-drop compatible with JOSM, QGIS, OsmAnd, and Garmin
 */
function toGpx(routeData) {
  const { details, stops, polyline } = routeData;
  const osmRef = details.oprsNo || details.routeName || details.serviceDocId;
  const name = `APSRTC Bus ${osmRef}: ${details.sourceName} => ${details.destinationName}`;
  const time = new Date().toISOString();

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<gpx version="1.1" creator="APSRTC Live Bus Tracker - OSM Exporter" xmlns="http://www.topografix.com/GPX/1/1">\n';
  xml += '  <metadata>\n';
  xml += `    <name>${escapeXml(name)}</name>\n`;
  xml += `    <desc>Service Type: ${escapeXml(details.serviceType)} | Depot: ${escapeXml(details.depotName)} | Route: ${escapeXml(details.routeName)} | Sched: ${escapeXml(details.startTime)} - ${escapeXml(details.endTime)}</desc>\n`;
  xml += `    <time>${time}</time>\n`;
  xml += '  </metadata>\n';

  // Bus stops as waypoints (<wpt>)
  for (const s of stops) {
    const padSeq = String(s.seqNo).padStart(2, '0');
    xml += `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">\n`;
    xml += `    <name>[${padSeq}] ${escapeXml(s.name)}</name>\n`;
    xml += `    <desc>Seq: #${s.seqNo} | Code: ${escapeXml(s.placeCode)} | Sched: ${escapeXml(s.scheduleTime || 'N/A')}</desc>\n`;
    xml += '    <sym>bus_stop</sym>\n';
    xml += '    <type>platform</type>\n';
    xml += '  </wpt>\n';
  }

  // Route track line (<trk>)
  xml += '  <trk>\n';
  xml += `    <name>${escapeXml(osmRef)} (${escapeXml(details.sourceName)} -> ${escapeXml(details.destinationName)})</name>\n`;
  xml += `    <type>${escapeXml(getOsmServiceCategory(details.serviceType))}</type>\n`;
  xml += '    <trkseg>\n';
  for (const [lat, lng] of polyline) {
    xml += `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>\n`;
  }
  xml += '    </trkseg>\n';
  xml += '  </trk>\n';
  xml += '</gpx>\n';

  return xml;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Fetches and structures complete route data for a serviceDocId
 */
async function getRouteData(serviceDocId) {
  const [detailsDoc, rawWaypoints] = await Promise.all([
    fetchServiceDetails(serviceDocId).catch(() => null),
    fetchServiceWaypointDetails(serviceDocId).catch(() => [])
  ]);

  const sortedWaypoints = [...(rawWaypoints || [])].sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));

  const stops = sortedWaypoints.map(w => {
    const lat = parseFloat(w.latitude);
    const lng = parseFloat(w.longitude);
    return {
      seqNo: w.seqNo,
      placeId: w.placeId,
      placeCode: w.placeCode || '',
      name: w.placeName || w.stationName || w.wayPointName || '',
      lat,
      lng,
      scheduleTime: w.scheduleDepTime || w.placeTime || '',
      vtsArrivalTime: w.vtsArrivalTime ? new Date(w.vtsArrivalTime).toISOString() : null,
      vtsDepartureTime: w.vtsDepartureTime ? new Date(w.vtsDepartureTime).toISOString() : null
    };
  }).filter(s => !isNaN(s.lat) && !isNaN(s.lng) && s.lat !== 0 && s.lng !== 0);

  const polyline = stops.map(s => [s.lat, s.lng]);

  const sourceName = detailsDoc?.sourceName || (stops.length > 0 ? stops[0].name : 'ORIGIN');
  const destinationName = detailsDoc?.destinationName || (stops.length > 0 ? stops[stops.length - 1].name : 'DESTINATION');

  const details = {
    serviceDocId,
    serviceType: detailsDoc?.serviceType || 'ORDINARY',
    oprsNo: detailsDoc?.oprsNo || '',
    routeName: detailsDoc?.routeName || '',
    depotName: detailsDoc?.depotName || 'APSRTC',
    sourceName,
    destinationName,
    startTime: detailsDoc?.serviceStartTime || '',
    endTime: detailsDoc?.serviceEndTime || '',
    busNo: detailsDoc?.vehicleNumber || '',
    driverName: detailsDoc?.driverName || '',
    driverMobile: detailsDoc?.driverMobileNo || '',
    tripNumber: detailsDoc?.tripNumber || '1'
  };

  return {
    details,
    stops,
    polyline
  };
}

/**
 * Exports a single service route to GeoJSON, GPX, and JSON
 */
async function exportRoute(serviceDocId, options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), 'history', 'routes');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const routeData = await getRouteData(serviceDocId);
  const { details, stops } = routeData;

  if (stops.length === 0) {
    throw new Error(`No waypoint coordinates found for trip ${serviceDocId}`);
  }

  // Construct descriptive filename:
  // e.g. CITY_ORDINARY_KV11-4_KOTTAVALASA_to_RK_BEACH_03112026_KV11_4_SIMHACHALAM
  const cleanType = sanitizeFileNamePart(details.serviceType);
  const cleanRef = sanitizeFileNamePart(details.oprsNo || details.routeName || 'ROUTE');
  const cleanFrom = sanitizeFileNamePart(details.sourceName);
  const cleanTo = sanitizeFileNamePart(details.destinationName);
  const cleanDocId = sanitizeFileNamePart(serviceDocId);

  const baseFileName = `${cleanType}_${cleanRef}_${cleanFrom}_to_${cleanTo}_${cleanDocId}`;

  const writtenFiles = [];
  const format = (options.format || 'all').toLowerCase();

  // 1. GeoJSON (with OSM relation tags)
  if (format === 'all' || format === 'geojson') {
    const geojson = toGeoJson(routeData);
    const geojsonPath = path.join(outDir, `${baseFileName}.geojson`);
    fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2), 'utf-8');
    writtenFiles.push(geojsonPath);
  }

  // 2. GPX 1.1 (for JOSM, OsmAnd, QGIS)
  if (format === 'all' || format === 'gpx') {
    const gpxXml = toGpx(routeData);
    const gpxPath = path.join(outDir, `${baseFileName}.gpx`);
    fs.writeFileSync(gpxPath, gpxXml, 'utf-8');
    writtenFiles.push(gpxPath);
  }

  // 3. Raw JSON Archive
  if (format === 'all' || format === 'json') {
    const jsonPath = path.join(outDir, `${baseFileName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(routeData, null, 2), 'utf-8');
    writtenFiles.push(jsonPath);
  }

  return {
    serviceDocId,
    baseFileName,
    outDir,
    details,
    stopsCount: stops.length,
    files: writtenFiles
  };
}

/**
 * Bulk exports multiple routes with concurrency control
 */
async function exportMultipleRoutes(serviceDocIds, options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), 'history', 'routes');
  const concurrency = options.concurrency || 4;
  const results = {
    total: serviceDocIds.length,
    success: 0,
    failed: 0,
    exported: [],
    errors: []
  };

  console.log(`[RouteExporter] Starting export of ${serviceDocIds.length} routes to: ${outDir}`);

  // Process in chunks
  for (let i = 0; i < serviceDocIds.length; i += concurrency) {
    const chunk = serviceDocIds.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (docId) => {
      try {
        const res = await exportRoute(docId, options);
        results.success++;
        results.exported.push(res);
        console.log(`  ✔ [${results.success}/${results.total}] Exported: ${res.baseFileName} (${res.stopsCount} stops)`);
      } catch (err) {
        results.failed++;
        results.errors.push({ docId, error: err.message });
        console.warn(`  ✖ Failed ${docId}: ${err.message}`);
      }
    }));
  }

  console.log(`[RouteExporter] Export completed: ${results.success} succeeded, ${results.failed} failed.\n`);
  return results;
}

module.exports = {
  getRouteData,
  toGeoJson,
  toGpx,
  exportRoute,
  exportMultipleRoutes,
  sanitizeFileNamePart
};

