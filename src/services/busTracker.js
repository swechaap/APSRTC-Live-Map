const {
  fetchMappedPlaces,
  fetchActiveTrips,
  fetchServiceDetails,
  fetchTrackingDetails,
  fetchBatchTrackingDetails,
  fetchLiveBusLocation,
  searchBusTracking,
  fetchTrackingByDepot,
  fetchServiceWaypointDetails,
  getApsrtcDates
} = require('./apsrtcApi');

const fs = require('fs');
const path = require('path');

const FILTERS_FILE = path.join(__dirname, '../../cache/filters.json');

class BusTracker {
  constructor() {
    this.placesMap = new Map();
    this.riderStopsById = new Map();
    this.busesCache = [];
    this.knownFilters = { depots: new Set(), serviceTypes: new Set() };
    this.tripStopsByBus = new Map();
    this.cachedTripDocs = null;
    this.lastTripSync = null;
    this.lastSync = null;
    this.isSyncing = false;
    this.pollInterval = null;
  }

  /**
   * Loads and indexes all bus stops across Andhra Pradesh
   */
  async init() {
    console.log('[BusTracker] Initializing stop database...');
    try {
      const saved = JSON.parse(fs.readFileSync(FILTERS_FILE, 'utf8'));
      (saved.depots || []).forEach(d => this.knownFilters.depots.add(d));
      (saved.serviceTypes || []).forEach(t => this.knownFilters.serviceTypes.add(t));
    } catch (err) {
      // No saved filters yet
    }
    const places = await fetchMappedPlaces();
    this.placesMap.clear();
    this.riderStopsById.clear();

    for (const p of places) {
      const lat = parseFloat(p.latitude);
      const lng = parseFloat(p.longitude);
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;

      const info = {
        id: String(p.placeId),
        linkId: String(p.linkPlaceId || p.placeId),
        name: p.placeName || '',
        lat,
        lng,
        district: p.district || '',
        mandal: p.mandalName || ''
      };

      this.placesMap.set(String(p.placeId), info);
      if (p.linkPlaceId) this.placesMap.set(String(p.linkPlaceId), info);
      this.riderStopsById.set(info.id, info);
    }
    for (const info of this.riderStopsById.values()) {
      if (!this.riderStopsById.has(info.linkId)) this.riderStopsById.set(info.linkId, info);
    }
    console.log(`[BusTracker] Successfully indexed ${this.placesMap.size} valid GPS stops.`);

    // Initial bus sync
    await this.syncActiveBuses();
  }

  /**
   * Starts background polling for live updates
   */
  startPolling(intervalMs = 20000) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(async () => {
      try {
        await this.syncActiveBuses();
      } catch (err) {
        console.error('[BusTracker] Background sync error:', err.message);
      }
    }, intervalMs);
    console.log(`[BusTracker] Auto-refresh polling enabled every ${intervalMs / 1000}s`);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Fetches live trips from APSRTC Firestore and resolves GPS coordinates
   */
  async syncActiveBuses(forceTripRefresh = false) {
    if (this.isSyncing) return this.busesCache;
    this.isSyncing = true;

    try {
      const now = Date.now();
      const needsTripRefresh = forceTripRefresh || !this.lastTripSync || (now - this.lastTripSync > 180000);

      let tripDocsPromise;
      if (needsTripRefresh || !this.cachedTripDocs || this.cachedTripDocs.length === 0) {
        tripDocsPromise = this.fetchTripsForJourneyDates().then(docs => {
          if (docs && docs.length > 0) {
            this.cachedTripDocs = docs;
            this.lastTripSync = Date.now();
          }
          return docs || [];
        }).catch(err => {
          console.warn('[BusTracker] Error fetching trips:', err.message);
          return this.cachedTripDocs || [];
        });
      } else {
        tripDocsPromise = Promise.resolve(this.cachedTripDocs);
      }

      const tripDocs = await tripDocsPromise;
      const tripDocIds = tripDocs.map(d => d.name ? d.name.split('/').pop() : d.fields?.serviceDocId?.stringValue).filter(Boolean);

      // Fetch pinpoint real-time GPS locations for ALL active trips using parallel batchGet
      console.log(`[BusTracker] Resolving live GPS fixes for ${tripDocIds.length} active trips via parallel batchGet...`);
      const liveTrackingMap = await fetchBatchTrackingDetails(tripDocIds).catch(err => {
        console.warn('[BusTracker] Error fetching batch tracking:', err.message);
        return new Map();
      });

      const mapped = [];
      const tripStopsByBus = new Map();
      const stopOccupancy = new Map();

      for (const doc of tripDocs) {
        const f = doc.fields || {};
        const serviceDocId = doc.name.split('/').pop();

        const busNo = f.vehicleNumber?.stringValue || 'Unknown';
        const oprsNo = f.oprsNo?.stringValue || '';
        const serviceType = f.serviceType?.stringValue || 'ORDINARY';
        const routeName = f.routeName?.stringValue || '';
        const depotName = f.depotName?.stringValue || 'APSRTC';
        const sourceName = f.sourceName?.stringValue || '';
        const destinationName = f.destinationName?.stringValue || '';
        const driverName = f.driverName?.stringValue || '';
        const driverMobile = f.driverMobileNo?.stringValue || '';
        const refreshedAt = f.refreshedAt?.stringValue || '';
        const refreshedTimestamp = f.refreshedTimeStamp?.integerValue || Date.now();
        const tripNumber = f.tripNumber?.stringValue || '1';
        const currentSeqNo = parseInt(f.currentSeqNo?.stringValue || '1', 10);
        const startTime = f.serviceStartTime?.stringValue || '';
        const endTime = f.serviceEndTime?.stringValue || '';

        // Determine current boarding stop info from placesMap
        const currPoint = f.currentBoardingPoint?.stringValue;
        const prevPoint = f.prevBoardingPoint?.stringValue;
        const stageLeft = f.stageLeftId?.stringValue;
        const srcId = String(f.sourceId?.integerValue || '');
        const srcLinkId = String(f.sourceLinkId?.integerValue || '');

        let place = null;
        let isEstimatedAtSource = false;

        if (currPoint && this.placesMap.has(currPoint)) {
          place = this.placesMap.get(currPoint);
        } else if (prevPoint && this.placesMap.has(prevPoint)) {
          place = this.placesMap.get(prevPoint);
        } else if (stageLeft && this.placesMap.has(stageLeft)) {
          place = this.placesMap.get(stageLeft);
        } else if (srcId && this.placesMap.has(srcId)) {
          place = this.placesMap.get(srcId);
          isEstimatedAtSource = true;
        } else if (srcLinkId && this.placesMap.has(srcLinkId)) {
          place = this.placesMap.get(srcLinkId);
          isEstimatedAtSource = true;
        }

        // Check if we have exact real-time GPS coordinates from trackingDetailsV2
        const liveGps = liveTrackingMap.get(serviceDocId);
        let lat = null;
        let lng = null;
        let isLiveGps = false;
        let speed = 0;
        let bearing = 0;
        let isOnline = false;

        if (liveGps) {
          lat = liveGps.lat;
          lng = liveGps.lng;
          speed = liveGps.speed;
          bearing = liveGps.bearing;
          isOnline = liveGps.isOnline;
          isLiveGps = true;
        } else if (place) {
          // Fallback to scheduled boarding stop with dispersion if multiple buses share same stop
          const stopKey = `${place.lat.toFixed(4)},${place.lng.toFixed(4)}`;
          const countAtStop = stopOccupancy.get(stopKey) || 0;
          stopOccupancy.set(stopKey, countAtStop + 1);

          if (countAtStop === 0) {
            lat = place.lat;
            lng = place.lng;
          } else {
            // Disperse subsequent buses around the stop (radius ~25-40 meters)
            const angle = (countAtStop * 137.5) * (Math.PI / 180);
            const dist = 0.0003;
            lat = place.lat + (Math.sin(angle) * dist);
            lng = place.lng + (Math.cos(angle) * dist);
          }
        } else {
          // If neither live GPS nor stop can be resolved, skip
          continue;
        }

        // Waypoint list if present
        const wayPointString = f.wayPointString?.stringValue || '';
        const totalWaypoints = wayPointString ? wayPointString.split(',').length : null;
        tripStopsByBus.set(serviceDocId, wayPointString.split(',').map(id => id.trim()).filter(Boolean));

        mapped.push({
          id: serviceDocId,
          serviceDocId,
          busNo,
          oprsNo,
          serviceType,
          routeName,
          depotName,
          sourceName,
          destinationName,
          driverName,
          driverMobile,
          refreshedAt,
          refreshedTimestamp: Number(refreshedTimestamp),
          tripNumber,
          currentSeqNo,
          totalWaypoints,
          startTime,
          endTime,
          isEstimatedAtSource,
          isLiveGps,
          speed,
          bearing,
          isOnline,
          currentStop: place ? place.name : (isLiveGps ? 'In Transit' : 'Unknown'),
          district: place ? place.district : '',
          lat,
          lng
        });
      }

      this.busesCache = mapped;
      this.rememberFilters(mapped);
      this.tripStopsByBus = tripStopsByBus;
      this.lastSync = new Date();
      const liveCount = mapped.filter(b => b.isLiveGps).length;
      console.log(`[BusTracker] Synced ${mapped.length} active buses (${liveCount} with real-time GPS movement) at ${this.lastSync.toLocaleTimeString()}`);
      return mapped;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Trips that began before midnight keep yesterday's journeyDate, so in the
   * early hours we also fetch the previous day's running trips.
   */
  async fetchTripsForJourneyDates() {
    const now = new Date();
    const dates = [null];
    if (now.getHours() < 6) {
      dates.push(getApsrtcDates(new Date(now.getTime() - 24 * 60 * 60 * 1000)).journeyDate);
    }
    const settled = await Promise.allSettled(dates.map(d => fetchActiveTrips(d, 12000)));
    const seen = new Set();
    const docs = [];
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const doc of r.value) {
        if (seen.has(doc.name)) continue;
        seen.add(doc.name);
        docs.push(doc);
      }
    }
    if (docs.length === 0 && settled.every(r => r.status === 'rejected')) throw settled[0].reason;
    return docs;
  }

  /**
   * Remembers every depot and service type ever seen so the filters stay complete
   * even when few buses are running (e.g. late at night).
   */
  rememberFilters(buses) {
    let changed = false;
    for (const b of buses) {
      if (b.depotName && !this.knownFilters.depots.has(b.depotName)) {
        this.knownFilters.depots.add(b.depotName);
        changed = true;
      }
      if (b.serviceType && !this.knownFilters.serviceTypes.has(b.serviceType)) {
        this.knownFilters.serviceTypes.add(b.serviceType);
        changed = true;
      }
    }
    if (changed) {
      try {
        fs.writeFileSync(FILTERS_FILE, JSON.stringify(this.getKnownFilters()));
      } catch (err) {
        console.warn('[BusTracker] Could not persist filters:', err.message);
      }
    }
  }

  getKnownFilters() {
    return {
      depots: [...this.knownFilters.depots].sort(),
      serviceTypes: [...this.knownFilters.serviceTypes].sort()
    };
  }

  /**
   * Returns current active buses
   */
  getActiveBuses() {
    return this.busesCache;
  }

  searchStops(query) {
    const text = query.trim().toLowerCase();
    const unique = new Map();
    for (const place of this.riderStopsById.values()) {
      if (place.name.toLowerCase().includes(text)) unique.set(place.id, place);
    }
    return [...unique.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.district.localeCompare(b.district))
      .slice(0, 30);
  }

  nearbyStops(lat, lng, limit = 8, maxKm = 3) {
    const kmPerDeg = 111;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const seen = new Set();
    const found = [];
    for (const stop of this.riderStopsById.values()) {
      if (seen.has(stop.id)) continue;
      seen.add(stop.id);
      const km = Math.hypot((stop.lat - lat) * kmPerDeg, (stop.lng - lng) * kmPerDeg * cosLat);
      if (km <= maxKm) found.push({ ...stop, distanceKm: km });
    }
    return found.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
  }

  getStopBuses(stopId) {
    const stop = this.riderStopsById.get(stopId);
    if (!stop) return null;
    return this.busesCache.filter(bus =>
      (this.tripStopsByBus.get(bus.serviceDocId) || [])
        .some(id => this.riderStopsById.get(id)?.linkId === stop.linkId)
    );
  }

  getBusesBetweenStops(fromId, toId) {
    const from = this.riderStopsById.get(fromId);
    const to = this.riderStopsById.get(toId);
    if (!from || !to || from.linkId === to.linkId) return null;
    return this.busesCache.filter(bus => {
      const stops = this.tripStopsByBus.get(bus.serviceDocId) || [];
      const fromIndex = stops.findIndex(id => this.riderStopsById.get(id)?.linkId === from.linkId);
      return fromIndex !== -1 && stops.slice(fromIndex + 1)
        .some(id => this.riderStopsById.get(id)?.linkId === to.linkId);
    });
  }

  /**
   * Returns summary statistics for UI dashboard
   */
  getStats() {
    const depots = new Set();
    const serviceTypes = {};
    const routes = new Set();

    for (const b of this.busesCache) {
      if (b.depotName) depots.add(b.depotName);
      if (b.routeName) routes.add(b.routeName);
      const st = b.serviceType || 'OTHER';
      serviceTypes[st] = (serviceTypes[st] || 0) + 1;
    }

    return {
      totalActive: this.busesCache.length,
      liveGpsCount: this.busesCache.filter(b => b.isLiveGps).length,
      depotsCount: depots.size,
      routesCount: routes.size,
      serviceTypes,
      depotsList: Array.from(depots).sort(),
      lastSync: this.lastSync ? this.lastSync.toISOString() : null
    };
  }

  /**
   * Converts all live buses into a standard GeoJSON FeatureCollection
   */
  toGeoJSON() {
    const features = this.busesCache.map(b => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [b.lng, b.lat] // GeoJSON is [lng, lat]
      },
      properties: { ...b }
    }));

    return {
      type: 'FeatureCollection',
      metadata: {
        generatedAt: new Date().toISOString(),
        count: features.length
      },
      features
    };
  }

  /**
   * Fetches latest live GPS location for a specific bus directly from trackingDetailsV2
   */
  async getLiveBusLocation(serviceDocId) {
    const live = await fetchLiveBusLocation(serviceDocId);
    if (live) {
      // Update in local cache as well
      const cached = this.busesCache.find(b => b.serviceDocId === serviceDocId);
      if (cached) {
        cached.lat = live.lat;
        cached.lng = live.lng;
        cached.speed = live.speed;
        cached.bearing = live.bearing;
        cached.isLiveGps = true;
        cached.isOnline = live.isOnline;
        cached.refreshedTimestamp = live.refreshedAt;
      }
    }
    return live;
  }

  /**
   * Searches buses in cache and directly in Firestore across busNo, DCP, OPRS, depot
   */
  async searchBuses(queryText) {
    const q = (queryText || '').trim().toLowerCase();
    if (!q) return this.busesCache;

    // 1. Check local cache
    let matches = this.busesCache.filter(b =>
      (b.busNo && b.busNo.toLowerCase().includes(q)) ||
      (b.oprsNo && b.oprsNo.toLowerCase().includes(q)) ||
      (b.serviceDocId && b.serviceDocId.toLowerCase().includes(q)) ||
      (b.depotName && b.depotName.toLowerCase().includes(q)) ||
      (b.routeName && b.routeName.toLowerCase().includes(q))
    );

    // 2. Query Firestore if local matches are few or if searching specific identifier
    const liveResults = await searchBusTracking(queryText);
    for (const live of liveResults) {
      let existing = this.busesCache.find(b => b.serviceDocId === live.serviceDocId);
      if (!existing) {
        const details = await fetchServiceDetails(live.serviceDocId).catch(() => null);
        existing = {
          id: live.serviceDocId,
          serviceDocId: live.serviceDocId,
          busNo: live.busNo || details?.vehicleNumber || 'Unknown',
          oprsNo: live.oprsNo || details?.oprsNo || '',
          serviceType: live.serviceType || details?.serviceType || 'ORDINARY',
          routeName: details?.routeName || '',
          depotName: live.depotName || details?.depotName || 'APSRTC',
          sourceName: details?.sourceName || '',
          destinationName: details?.destinationName || '',
          driverName: live.driverName || details?.driverName || '',
          driverMobile: details?.driverMobileNo || '',
          refreshedAt: new Date(live.refreshedAt).toLocaleTimeString(),
          refreshedTimestamp: live.refreshedAt,
          tripNumber: details?.tripNumber || '1',
          currentSeqNo: details?.currentSeqNo || 1,
          totalWaypoints: details?.totalWaypoints || null,
          startTime: details?.serviceStartTime || '',
          endTime: details?.serviceEndTime || '',
          isEstimatedAtSource: false,
          isLiveGps: true,
          speed: live.speed,
          bearing: live.bearing,
          isOnline: live.isOnline,
          currentStop: 'In Transit',
          district: '',
          lat: live.lat,
          lng: live.lng
        };
        this.busesCache.unshift(existing);
      } else if (!existing.sourceName || !existing.destinationName) {
        const details = await fetchServiceDetails(existing.serviceDocId).catch(() => null);
        if (details) {
          if (details.sourceName) existing.sourceName = details.sourceName;
          if (details.destinationName) existing.destinationName = details.destinationName;
          if (details.routeName) existing.routeName = details.routeName;
          if (details.serviceStartTime) existing.startTime = details.serviceStartTime;
          if (details.serviceEndTime) existing.endTime = details.serviceEndTime;
          if (details.driverMobileNo) existing.driverMobile = details.driverMobileNo;
        }
      }
      if (!matches.some(m => m.serviceDocId === existing.serviceDocId)) {
        matches.push(existing);
      }
    }

    return matches;
  }

  /**
   * Finds a bus in cache or queries trackingDetailsV2 directly
   */
  async findOrFetchBus(queryText) {
    const results = await this.searchBuses(queryText);
    const bus = results.length > 0 ? results[0] : null;
    if (bus && (!bus.sourceName || !bus.destinationName)) {
      const details = await fetchServiceDetails(bus.serviceDocId).catch(() => null);
      if (details) {
        if (details.sourceName) bus.sourceName = details.sourceName;
        if (details.destinationName) bus.destinationName = details.destinationName;
        if (details.routeName) bus.routeName = details.routeName;
        if (details.serviceStartTime) bus.startTime = details.serviceStartTime;
        if (details.serviceEndTime) bus.endTime = details.serviceEndTime;
        if (details.driverMobileNo) bus.driverMobile = details.driverMobileNo;
      }
    }
    return bus;
  }

  /**
   * Fetches and caches all buses running from a specific depot
   */
  async fetchBusesByDepot(depotName) {
    const dUpper = (depotName || '').trim().toUpperCase();
    if (!dUpper) return this.busesCache;

    // Check existing
    let cached = this.busesCache.filter(b => b.depotName && b.depotName.toUpperCase() === dUpper);

    // Fetch from Firestore
    const depotBuses = await fetchTrackingByDepot(dUpper);
    for (const db of depotBuses) {
      let existing = this.busesCache.find(b => b.serviceDocId === db.serviceDocId);
      if (!existing) {
        const details = await fetchServiceDetails(db.serviceDocId).catch(() => null);
        existing = {
          id: db.serviceDocId,
          serviceDocId: db.serviceDocId,
          busNo: db.busNo || details?.vehicleNumber || 'Unknown',
          oprsNo: db.oprsNo || details?.oprsNo || '',
          serviceType: db.serviceType || details?.serviceType || 'ORDINARY',
          routeName: details?.routeName || '',
          depotName: db.depotName || details?.depotName || dUpper,
          sourceName: details?.sourceName || '',
          destinationName: details?.destinationName || '',
          driverName: db.driverName || details?.driverName || '',
          driverMobile: details?.driverMobileNo || '',
          refreshedAt: new Date(db.refreshedAt).toLocaleTimeString(),
          refreshedTimestamp: db.refreshedAt,
          tripNumber: details?.tripNumber || '1',
          currentSeqNo: details?.currentSeqNo || 1,
          totalWaypoints: details?.totalWaypoints || null,
          startTime: details?.serviceStartTime || '',
          endTime: details?.serviceEndTime || '',
          isEstimatedAtSource: false,
          isLiveGps: true,
          speed: db.speed,
          bearing: db.bearing,
          isOnline: db.isOnline,
          currentStop: 'In Transit',
          district: '',
          lat: db.lat,
          lng: db.lng
        };
        this.busesCache.unshift(existing);
        cached.push(existing);
      }
    }

    return cached;
  }

  /**
   * Fetches full route and stop details for a single bus
   */
  async getBusRouteDetails(serviceDocId) {
    const rawWaypoints = await fetchServiceWaypointDetails(serviceDocId);
    
    // Sort waypoints by seqNo
    const sorted = [...rawWaypoints].sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));

    const stops = sorted.map(w => {
      const lat = parseFloat(w.latitude);
      const lng = parseFloat(w.longitude);
      const hasDeparted = !!w.vtsDepartureTime;
      const hasArrived = !!w.vtsArrivalTime;

      return {
        seqNo: w.seqNo,
        placeId: w.placeId,
        placeCode: w.placeCode || '',
        name: w.placeName || w.stationName || w.wayPointName || '',
        lat,
        lng,
        scheduleTime: w.scheduleDepTime || w.placeTime || '',
        hasDeparted,
        hasArrived,
        vtsDepartureTime: w.vtsDepartureTime ? new Date(w.vtsDepartureTime).toLocaleTimeString() : null,
        vtsArrivalTime: w.vtsArrivalTime ? new Date(w.vtsArrivalTime).toLocaleTimeString() : null,
        eta: w.ETA ? new Date(w.ETA).toLocaleTimeString() : null
      };
    }).filter(s => !isNaN(s.lat) && !isNaN(s.lng) && s.lat !== 0);

    const polyline = stops.map(s => [s.lat, s.lng]);

    return {
      serviceDocId,
      totalStops: stops.length,
      stops,
      polyline
    };
  }
}

module.exports = new BusTracker();

