const fs = require('fs');
const path = require('path');
const {
  fetchServiceDetails,
  fetchServiceWaypointDetails,
  fetchLiveBusLocation,
  fetchBatchTrackingDetails,
  searchBusTracking
} = require('./apsrtcApi');
const { sanitizeFileNamePart } = require('./routeExporter');

/**
 * Calculates distance in meters between two lat/lng coordinates (Haversine)
 */
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radius of the Earth in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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
 * Converts recorded live GPS breadcrumbs and stops into a standard GPX 1.1 trace
 * Supported natively by JOSM, QGIS, OsmAnd, and OSM trace uploads
 */
function toLiveGpx(tripRecord) {
  const { details, stops, points, stats } = tripRecord;
  const osmRef = details.oprsNo || details.routeName || details.serviceDocId;
  const title = `APSRTC Live GPS Trace: Bus ${osmRef} (${details.sourceName} -> ${details.destinationName})`;
  const desc = `Service: ${details.serviceType} | Vehicle: ${details.busNo} | Depot: ${details.depotName} | Recorded Points: ${points.length} | Distance: ${(stats.totalDistanceMeters / 1000).toFixed(2)} km`;
  const time = new Date().toISOString();

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<gpx version="1.1" creator="APSRTC Live GPS Route Recorder" xmlns="http://www.topografix.com/GPX/1/1">\n';
  xml += '  <metadata>\n';
  xml += `    <name>${escapeXml(title)}</name>\n`;
  xml += `    <desc>${escapeXml(desc)}</desc>\n`;
  xml += `    <time>${time}</time>\n`;
  xml += '  </metadata>\n';

  // Include scheduled bus stops as reference waypoints (<wpt>)
  if (Array.isArray(stops) && stops.length > 0) {
    for (const s of stops) {
      const padSeq = String(s.seqNo).padStart(2, '0');
      xml += `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">\n`;
      xml += `    <name>[${padSeq}] ${escapeXml(s.name)}</name>\n`;
      xml += `    <desc>Stop #${s.seqNo} | Code: ${escapeXml(s.placeCode)} | Sched: ${escapeXml(s.scheduleTime || 'N/A')}</desc>\n`;
      xml += '    <sym>bus_stop</sym>\n';
      xml += '    <type>platform</type>\n';
      xml += '  </wpt>\n';
    }
  }

  // Live GPS Track breadcrumbs (<trk>)
  xml += '  <trk>\n';
  xml += `    <name>${escapeXml(osmRef)} (${escapeXml(details.busNo)}) Live Driven GPS Path</name>\n`;
  xml += '    <type>bus</type>\n';
  xml += '    <trkseg>\n';

  for (const pt of points) {
    const ptIso = new Date(pt.timestamp).toISOString();
    xml += `      <trkpt lat="${pt.lat.toFixed(6)}" lon="${pt.lng.toFixed(6)}">\n`;
    if (pt.altitude) {
      xml += `        <ele>${pt.altitude.toFixed(1)}</ele>\n`;
    }
    xml += `        <time>${ptIso}</time>\n`;
    if (pt.speed !== undefined) {
      // Speed in m/s (APSRTC telemetry is km/h, convert to m/s for GPX spec)
      const speedMs = (pt.speed / 3.6).toFixed(2);
      xml += `        <speed>${speedMs}</speed>\n`;
    }
    if (pt.bearing !== undefined && pt.bearing !== 0) {
      xml += `        <course>${pt.bearing.toFixed(1)}</course>\n`;
    }
    xml += '      </trkpt>\n';
  }

  xml += '    </trkseg>\n';
  xml += '  </trk>\n';
  xml += '</gpx>\n';

  return xml;
}

/**
 * Converts recorded live GPS breadcrumbs into GeoJSON FeatureCollection
 */
function toLiveGeoJson(tripRecord) {
  const { details, stops, points, stats } = tripRecord;
  const osmRef = details.oprsNo || details.routeName || details.serviceDocId;

  const osmRelationTags = {
    'type': 'route',
    'route': 'bus',
    'name': `Bus ${osmRef}: ${details.sourceName} => ${details.destinationName}`,
    'ref': osmRef,
    'route_ref': details.routeName || '',
    'operator': 'APSRTC',
    'network': 'APSRTC',
    'network:wikidata': 'Q4653664',
    'from': details.sourceName,
    'to': details.destinationName,
    'public_transport:version': '2',
    'roundtrip': 'no',
    'source': 'APSRTC Live GPS Recorded Track'
  };

  const lineFeature = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map(pt => [pt.lng, pt.lat]) // [lng, lat]
    },
    properties: {
      role: 'live_route_gps_trace',
      serviceType: details.serviceType,
      oprsNo: details.oprsNo,
      busNo: details.busNo,
      depot: details.depotName,
      totalGpsPoints: points.length,
      distanceKm: (stats.totalDistanceMeters / 1000).toFixed(2),
      avgSpeedKmh: stats.avgSpeedKmh.toFixed(1),
      maxSpeedKmh: stats.maxSpeedKmh.toFixed(1),
      recordedDurationMinutes: ((stats.lastTimestamp - stats.firstTimestamp) / 60000).toFixed(1),
      osm_relation_tags: osmRelationTags
    }
  };

  // Stop point features
  const stopFeatures = (stops || []).map(s => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [s.lng, s.lat]
    },
    properties: {
      role: 'platform',
      seq: s.seqNo,
      name: s.name,
      placeCode: s.placeCode,
      scheduledTime: s.scheduleTime,
      osm_tags: {
        'highway': 'bus_stop',
        'public_transport': 'platform',
        'bus': 'yes',
        'name': s.name,
        'ref': s.placeCode || '',
        'operator': 'APSRTC',
        'network': 'APSRTC'
      }
    }
  }));

  return {
    type: 'FeatureCollection',
    properties: {
      metadata: {
        ...details,
        stats: {
          totalPoints: points.length,
          totalDistanceKm: (stats.totalDistanceMeters / 1000).toFixed(2),
          avgSpeedKmh: stats.avgSpeedKmh.toFixed(1),
          maxSpeedKmh: stats.maxSpeedKmh.toFixed(1),
          firstTimestamp: new Date(stats.firstTimestamp).toISOString(),
          lastTimestamp: new Date(stats.lastTimestamp).toISOString()
        }
      },
      osm_relation_tags: osmRelationTags
    },
    features: [lineFeature, ...stopFeatures]
  };
}

class GpsRouteRecorder {
  constructor(options = {}) {
    this.intervalSeconds = options.intervalSeconds || 15;
    this.outDir = options.outDir || path.join(process.cwd(), 'history', 'gps_traces');
    this.minDistanceMeters = options.minDistanceMeters || 4; // Ignore points moved < 4 meters
    this.activeRecords = new Map(); // serviceDocId -> tripRecord
    this.timer = null;
    this.isRunning = false;
    this.isFlushing = false;
    this.totalPointsLogged = 0;
  }

  /**
   * Initializes target trip tracking records and fetches initial metadata & stops
   */
  async registerTrip(serviceDocId, busHint = null) {
    if (this.activeRecords.has(serviceDocId)) {
      return this.activeRecords.get(serviceDocId);
    }

    const [detailsDoc, rawWaypoints] = await Promise.all([
      fetchServiceDetails(serviceDocId).catch(() => null),
      fetchServiceWaypointDetails(serviceDocId).catch(() => [])
    ]);

    const sortedStops = [...(rawWaypoints || [])].sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0)).map(w => ({
      seqNo: w.seqNo,
      placeId: w.placeId,
      placeCode: w.placeCode || '',
      name: w.placeName || w.stationName || w.wayPointName || '',
      lat: parseFloat(w.latitude),
      lng: parseFloat(w.longitude),
      scheduleTime: w.scheduleDepTime || w.placeTime || ''
    })).filter(s => !isNaN(s.lat) && !isNaN(s.lng) && s.lat !== 0);

    const sourceName = detailsDoc?.sourceName || busHint?.sourceName || (sortedStops.length > 0 ? sortedStops[0].name : 'ORIGIN');
    const destinationName = detailsDoc?.destinationName || busHint?.destinationName || (sortedStops.length > 0 ? sortedStops[sortedStops.length - 1].name : 'DESTINATION');

    const details = {
      serviceDocId,
      serviceType: detailsDoc?.serviceType || busHint?.serviceType || 'ORDINARY',
      oprsNo: detailsDoc?.oprsNo || busHint?.oprsNo || '',
      routeName: detailsDoc?.routeName || busHint?.routeName || '',
      depotName: detailsDoc?.depotName || busHint?.depotName || 'APSRTC',
      sourceName,
      destinationName,
      startTime: detailsDoc?.serviceStartTime || '',
      endTime: detailsDoc?.serviceEndTime || '',
      busNo: detailsDoc?.vehicleNumber || busHint?.busNo || 'Unknown'
    };

    // Construct descriptive file base name
    const cleanType = sanitizeFileNamePart(details.serviceType);
    const cleanRef = sanitizeFileNamePart(details.oprsNo || details.routeName || 'ROUTE');
    const cleanFrom = sanitizeFileNamePart(details.sourceName);
    const cleanTo = sanitizeFileNamePart(details.destinationName);
    const cleanDocId = sanitizeFileNamePart(serviceDocId);
    const baseFileName = `${cleanType}_${cleanRef}_${cleanFrom}_to_${cleanTo}_${cleanDocId}`;

    const tripRecord = {
      serviceDocId,
      baseFileName,
      details,
      stops: sortedStops,
      points: [],
      stats: {
        totalDistanceMeters: 0,
        maxSpeedKmh: 0,
        avgSpeedKmh: 0,
        speedSum: 0,
        firstTimestamp: null,
        lastTimestamp: null
      },
      lastFlushedCount: 0
    };

    this.activeRecords.set(serviceDocId, tripRecord);
    return tripRecord;
  }

  /**
   * Appends a new GPS telemetry fix to a trip record if valid and moved
   */
  addGpsPoint(serviceDocId, telemetry) {
    const record = this.activeRecords.get(serviceDocId);
    if (!record || !telemetry) return false;

    const lat = telemetry.lat;
    const lng = telemetry.lng;
    if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) {
      return false;
    }

    const timestamp = Number(telemetry.refreshedTimestamp || telemetry.locationTime || Date.now());
    const speed = parseFloat(telemetry.speed || 0) || 0;
    const bearing = parseFloat(telemetry.bearing || 0) || 0;
    const altitude = parseFloat(telemetry.altitude || 0) || 0;

    const lastPoint = record.points.length > 0 ? record.points[record.points.length - 1] : null;

    if (lastPoint) {
      // Calculate distance from previous point
      const dist = getDistanceMeters(lastPoint.lat, lastPoint.lng, lat, lng);

      // Skip duplicate reading if vehicle hasn't moved beyond threshold
      if (dist < this.minDistanceMeters) {
        return false;
      }

      // Add to total distance
      record.stats.totalDistanceMeters += dist;
    } else {
      record.stats.firstTimestamp = timestamp;
    }

    // Update stats
    record.stats.lastTimestamp = timestamp;
    if (speed > record.stats.maxSpeedKmh) {
      record.stats.maxSpeedKmh = speed;
    }
    record.stats.speedSum += speed;
    record.stats.avgSpeedKmh = record.stats.speedSum / (record.points.length + 1);

    record.points.push({
      lat,
      lng,
      speed,
      bearing,
      altitude,
      timestamp
    });

    this.totalPointsLogged++;
    return true;
  }

  /**
   * Flushes all active trip records to disk (.gpx, .geojson, .json)
   */
  flushToDisk() {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      if (!fs.existsSync(this.outDir)) {
        fs.mkdirSync(this.outDir, { recursive: true });
      }

      let flushedCount = 0;
      for (const [docId, record] of this.activeRecords.entries()) {
        if (record.points.length === 0) continue;

        // Only re-write if new points were added
        if (record.points.length === record.lastFlushedCount) continue;

        const gpx = toLiveGpx(record);
        const geojson = toLiveGeoJson(record);

        const gpxPath = path.join(this.outDir, `${record.baseFileName}.gpx`);
        const geojsonPath = path.join(this.outDir, `${record.baseFileName}.geojson`);
        const jsonPath = path.join(this.outDir, `${record.baseFileName}.json`);

        fs.writeFileSync(gpxPath, gpx, 'utf-8');
        fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2), 'utf-8');
        fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf-8');

        record.lastFlushedCount = record.points.length;
        flushedCount++;
      }

      return flushedCount;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Main poll loop: fetches live GPS fixes for all registered trips
   */
  async pollStep() {
    if (this.activeRecords.size === 0) return;

    const docIds = Array.from(this.activeRecords.keys());
    let newPointsCount = 0;

    // Use fast parallel batchGet to fetch live fixes
    try {
      const trackingMap = await fetchBatchTrackingDetails(docIds);

      for (const docId of docIds) {
        const live = trackingMap.get(docId);
        if (live) {
          const added = this.addGpsPoint(docId, live);
          if (added) newPointsCount++;
        }
      }

      // Auto-flush to disk when new points arrive
      if (newPointsCount > 0) {
        this.flushToDisk();
      }
    } catch (err) {
      console.warn(`[GpsRouteRecorder] Poll error: ${err.message}`);
    }

    return newPointsCount;
  }

  /**
   * Starts background recording loop
   */
  start(onTick = null) {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[GpsRouteRecorder] Started live recording. Polling every ${this.intervalSeconds}s...`);

    // Run first step immediately
    this.pollStep().then(count => {
      if (onTick) onTick(this.getStatusSummary());
    });

    this.timer = setInterval(async () => {
      await this.pollStep();
      if (onTick) onTick(this.getStatusSummary());
    }, this.intervalSeconds * 1000);
  }

  /**
   * Stops recording and flushes all files
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.flushToDisk();
    console.log(`[GpsRouteRecorder] Stopped recording. All traces saved to ${this.outDir}`);
  }

  /**
   * Returns live status summary of all monitored trips
   */
  getStatusSummary() {
    const trips = [];
    for (const [docId, r] of this.activeRecords.entries()) {
      const lastPt = r.points.length > 0 ? r.points[r.points.length - 1] : null;
      trips.push({
        serviceDocId: docId,
        baseFileName: r.baseFileName,
        busNo: r.details.busNo,
        oprsNo: r.details.oprsNo,
        serviceType: r.details.serviceType,
        route: `${r.details.sourceName} -> ${r.details.destinationName}`,
        depot: r.details.depotName,
        pointsCount: r.points.length,
        distanceKm: (r.stats.totalDistanceMeters / 1000).toFixed(2),
        currentSpeed: lastPt ? `${lastPt.speed.toFixed(1)} km/h` : 'Waiting fix',
        currentCoords: lastPt ? `${lastPt.lat.toFixed(5)}, ${lastPt.lng.toFixed(5)}` : 'Waiting fix',
        lastUpdated: lastPt ? new Date(lastPt.timestamp).toLocaleTimeString() : 'N/A'
      });
    }

    return {
      activeBuses: this.activeRecords.size,
      totalPointsLogged: this.totalPointsLogged,
      outDir: this.outDir,
      trips
    };
  }
}

module.exports = {
  GpsRouteRecorder,
  toLiveGpx,
  toLiveGeoJson,
  getDistanceMeters
};
