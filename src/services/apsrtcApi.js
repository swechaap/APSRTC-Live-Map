const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Constants discovered from apsrtclivetrack.com client
const API_BASE_URL = 'https://utsappapicached01.apsrtconline.in/uts-vts-api';
const FIRESTORE_QUERY_URL = 'https://firestore.googleapis.com/v1/projects/apsrtc-uts-prod/databases/(default)/documents:runQuery';
const API_KEY = '53693855434468454E714A596D44457A586975414F573833334833596A584D3333735938444A69357131303D';
const USER_ID = '1363789069449';
const ENC_KEY_B64 = process.env.APSRTC_CLIENT_KEY;
if (!ENC_KEY_B64) {
  throw new Error('APSRTC_CLIENT_KEY is not set. Add it to .env (local) or the Render Environment tab.');
}
const ENC_KEY = Buffer.from(ENC_KEY_B64, 'base64');

const CACHE_DIR = path.join(__dirname, '../../cache');
const PLACES_CACHE_FILE = path.join(CACHE_DIR, 'places.json');

/**
 * Formats the current date into APSRTC formats:
 * - journeyDate: '02-Nov-2026'
 * - docDate: '02112026'
 */
function getApsrtcDates(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const monthNum = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return {
    journeyDate: `${day}-${month}-${year}`,
    docDate: `${day}${monthNum}${year}`
  };
}

/**
 * Generic HTTPS JSON request helper
 */
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
      ...(options.headers || {})
    };

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 15000
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${options.timeout || 15000}ms: ${url}`));
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * AES-256-GCM + Raw Deflate query token encoder
 */
function encryptQueryToken(payloadObj) {
  const jsonStr = JSON.stringify(payloadObj);
  const compressed = zlib.deflateRawSync(jsonStr, { level: 9 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Version 0x01 + 12-byte IV + ciphertext + 16-byte GCM tag
  const tokenBuffer = Buffer.concat([Buffer.from([0x01]), iv, encrypted, tag]);
  return tokenBuffer.toString('base64url');
}

/**
 * Fetches and caches all 12,500+ bus stop GPS coordinates
 */
async function fetchMappedPlaces(forceRefresh = false) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Check local disk cache (valid for 24 hours)
  if (!forceRefresh && fs.existsSync(PLACES_CACHE_FILE)) {
    try {
      const stats = fs.statSync(PLACES_CACHE_FILE);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) {
        const cached = JSON.parse(fs.readFileSync(PLACES_CACHE_FILE, 'utf-8'));
        if (Array.isArray(cached) && cached.length > 5000) {
          return cached;
        }
      }
    } catch (err) {
      console.warn('Could not read places cache, fetching fresh copy:', err.message);
    }
  }

  console.log('Fetching latest mapped places catalog from APSRTC API...');
  const res = await requestJson(`${API_BASE_URL}/mappedplaces/fetchAllUniquePlaces`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer abhibus',
      'x-api-key': API_KEY,
      'userId': USER_ID
    },
    timeout: 30000
  });

  const places = res.miniServicePlaces || [];
  if (places.length > 0) {
    fs.writeFileSync(PLACES_CACHE_FILE, JSON.stringify(places));
    console.log(`Saved ${places.length} mapped places to cache.`);
  }
  return places;
}

const ACTIVE_TRIP_FIELDS = [
  'vehicleNumber',
  'oprsNo',
  'serviceType',
  'routeName',
  'depotName',
  'sourceName',
  'destinationName',
  'driverName',
  'driverMobileNo',
  'serviceStartTime',
  'serviceEndTime',
  'currentBoardingPoint',
  'prevBoardingPoint',
  'stageLeftId',
  'sourceId',
  'sourceLinkId',
  'tripNumber',
  'currentSeqNo',
  'wayPointString',
  'refreshedAt',
  'refreshedTimeStamp'
];

/**
 * Queries active running bus trips for today from Firestore serviceDetails
 * Uses field projection to cut payload size by 70% and prevent timeouts
 */
async function fetchActiveTrips(customDate = null, limit = 12000, retries = 1) {
  const dates = getApsrtcDates();
  const journeyDate = customDate || dates.journeyDate;

  const query = {
    structuredQuery: {
      select: {
        fields: ACTIVE_TRIP_FIELDS.map(f => ({ fieldPath: f }))
      },
      from: [{ collectionId: 'serviceDetails' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'journeyDate' },
                op: 'EQUAL',
                value: { stringValue: journeyDate }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: 'tripStatus' },
                op: 'EQUAL',
                value: { stringValue: '1' } // 1 = Running / Active trip
              }
            }
          ]
        }
      },
      limit
    }
  };

  try {
    const results = await requestJson(FIRESTORE_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: query,
      timeout: 45000
    });

    return (Array.isArray(results) ? results : []).filter(r => r && r.document).map(r => r.document);
  } catch (err) {
    if (retries > 0) {
      console.warn(`[fetchActiveTrips] Request failed (${err.message}). Retrying in 1.5s...`);
      await new Promise(r => setTimeout(r, 1500));
      return fetchActiveTrips(customDate, limit, retries - 1);
    }
    throw err;
  }
}

/**
 * Fetches service details (origin, destination, timings, driver info) from Firestore serviceDetails/{docId}
 */
async function fetchServiceDetails(serviceDocId) {
  if (!serviceDocId) return null;
  const url = `https://firestore.googleapis.com/v1/projects/apsrtc-uts-prod/databases/(default)/documents/serviceDetails/${encodeURIComponent(serviceDocId)}`;
  try {
    const doc = await requestJson(url, { timeout: 10000 });
    if (!doc || !doc.fields) return null;
    const f = doc.fields;
    return {
      serviceDocId,
      sourceName: f.sourceName?.stringValue || '',
      destinationName: f.destinationName?.stringValue || '',
      routeName: f.routeName?.stringValue || '',
      serviceStartTime: f.serviceStartTime?.stringValue || '',
      serviceEndTime: f.serviceEndTime?.stringValue || '',
      driverName: f.driverName?.stringValue || '',
      driverMobileNo: f.driverMobileNo?.stringValue || '',
      vehicleNumber: f.vehicleNumber?.stringValue || '',
      oprsNo: f.oprsNo?.stringValue || '',
      depotName: f.depotName?.stringValue || '',
      serviceType: f.serviceType?.stringValue || '',
      tripStatus: f.tripStatus?.stringValue || '',
      tripNumber: f.tripNumber?.stringValue || '1',
      currentSeqNo: parseInt(f.currentSeqNo?.stringValue || '1', 10),
      totalWaypoints: f.wayPointString?.stringValue ? f.wayPointString.stringValue.split(',').length : null
    };
  } catch (err) {
    if (err.message && err.message.includes('404')) {
      return null;
    }
    console.warn(`[fetchServiceDetails] Error fetching details for ${serviceDocId}:`, err.message);
    return null;
  }
}

/**
 * Queries real-time GPS locations from Firestore trackingDetailsV2
 */
async function fetchTrackingDetails(customDate = null, limit = 1000) {
  const dates = getApsrtcDates();
  const journeyDate = customDate || dates.journeyDate;

  const query = {
    structuredQuery: {
      from: [{ collectionId: 'trackingDetailsV2' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'journeyDate' },
          op: 'EQUAL',
          value: { stringValue: journeyDate }
        }
      },
      limit
    }
  };

  const results = await requestJson(FIRESTORE_QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: query,
    timeout: 20000
  });

  return (Array.isArray(results) ? results : []).filter(r => r && r.document).map(r => r.document);
}

/**
 * Fetches real-time GPS fixes for a list of serviceDocIds in parallel using Firestore batchGet
 */
async function fetchBatchTrackingDetails(serviceDocIds) {
  if (!Array.isArray(serviceDocIds) || serviceDocIds.length === 0) {
    return new Map();
  }

  const chunkSize = 350;
  const chunks = [];
  for (let i = 0; i < serviceDocIds.length; i += chunkSize) {
    chunks.push(serviceDocIds.slice(i, i + chunkSize));
  }

  const results = [];
  const batchSize = 5;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(chunk => {
      const payload = {
        documents: chunk.map(id => `projects/apsrtc-uts-prod/databases/(default)/documents/trackingDetailsV2/${id}`)
      };
      return requestJson('https://firestore.googleapis.com/v1/projects/apsrtc-uts-prod/databases/(default)/documents:batchGet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeout: 20000
      }).catch(err => {
        console.warn('[fetchBatchTrackingDetails] Chunk error:', err.message);
        return [];
      });
    }));
    results.push(...batchResults);
  }

  const trackingMap = new Map();
  for (const chunkRes of results) {
    if (!Array.isArray(chunkRes)) continue;
    for (const item of chunkRes) {
      if (item.found && item.found.fields) {
        const f = item.found.fields;
        const docId = item.found.name.split('/').pop();
        const lat = f.latitude?.doubleValue;
        const lng = f.longitude?.doubleValue;
        if (docId && lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          trackingMap.set(docId, {
            lat,
            lng,
            speed: parseFloat(f.speed?.stringValue || '0') || 0,
            bearing: f.locationBearing?.doubleValue || 0,
            altitude: f.locationAltitude?.doubleValue || 0,
            isOnline: f.isOnline?.stringValue === '1',
            locationTime: f.locationTime?.stringValue || null,
            refreshedTimestamp: Number(f.refreshedAt?.integerValue || Date.now())
          });
        }
      }
    }
  }

  return trackingMap;
}

/**
 * Fetches the latest live GPS fix for a single bus directly from trackingDetailsV2
 */
async function fetchLiveBusLocation(serviceDocId) {
  const url = `https://firestore.googleapis.com/v1/projects/apsrtc-uts-prod/databases/(default)/documents/trackingDetailsV2/${encodeURIComponent(serviceDocId)}`;
  try {
    const doc = await requestJson(url, { timeout: 10000 });
    if (!doc || !doc.fields) return null;
    const f = doc.fields;
    const lat = f.latitude?.doubleValue;
    const lng = f.longitude?.doubleValue;
    if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) {
      return null;
    }
    return {
      serviceDocId,
      busNo: f.vehicleNumber?.stringValue || f.busNumber?.stringValue || '',
      oprsNo: f.oprsNo?.stringValue || '',
      depotName: f.depotName?.stringValue || '',
      serviceType: f.serviceType?.stringValue || '',
      driverName: f.driverName?.stringValue || '',
      lat,
      lng,
      speed: parseFloat(f.speed?.stringValue || '0') || 0,
      bearing: f.locationBearing?.doubleValue || 0,
      altitude: f.locationAltitude?.doubleValue || 0,
      isOnline: f.isOnline?.stringValue === '1',
      locationTime: f.locationTime?.stringValue || null,
      refreshedAt: Number(f.refreshedAt?.integerValue || Date.now()),
      updateTime: doc.updateTime || null
    };
  } catch (err) {
    if (err.message && err.message.includes('404')) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetches stop-by-stop GPS waypoints, arrival/departure history, and ETAs for a specific trip
 */
async function fetchServiceWaypointDetails(serviceDocId, hardRefresh = true) {
  const q = encryptQueryToken({ docId: serviceDocId, hardRefresh });
  const url = `${API_BASE_URL}/servicewaypointdetails/bydocid?q=${q}`;

  const res = await requestJson(url, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer abhibus',
      'x-api-key': API_KEY,
      'userId': USER_ID
    },
    timeout: 10000
  });

  return res.data || [];
}

/**
 * Fetches the complete list of service numbers scheduled today
 */
async function fetchAllServiceNumbers() {
  const res = await requestJson(`${API_BASE_URL}/servicesnumbers/all`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer abhibus',
      'x-api-key': API_KEY,
      'userId': USER_ID
    },
    timeout: 15000
  });
  return res.data || [];
}

/**
 * Queries tracking details for a specific bus number, DCP code, OPRS service, depot, or docId today
 */
async function searchBusTracking(queryText) {
  const dates = getApsrtcDates();
  const qStr = (queryText || '').trim();
  if (!qStr) return [];

  // 1. Try direct docId get if it looks like a serviceDocId (e.g. 03112026_...)
  if (qStr.startsWith(dates.docDate) || (qStr.includes('_') && qStr.length > 15)) {
    const live = await fetchLiveBusLocation(qStr);
    if (live) return [live];
  }

  const qUpper = qStr.toUpperCase();
  const fieldsToTry = ['busNumber', 'dcp', 'oprsNo', 'depotName'];
  const matchedDocs = [];

  for (const field of fieldsToTry) {
    const query = {
      structuredQuery: {
        from: [{ collectionId: 'trackingDetailsV2' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: field },
                  op: 'EQUAL',
                  value: { stringValue: qUpper }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: 'journeyDate' },
                  op: 'EQUAL',
                  value: { stringValue: dates.journeyDate }
                }
              }
            ]
          }
        },
        limit: 30
      }
    };

    try {
      const results = await requestJson(FIRESTORE_QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: query,
        timeout: 10000
      });

      const docs = (Array.isArray(results) ? results : []).filter(r => r && r.document).map(r => r.document);
      if (docs.length > 0) {
        for (const doc of docs) {
          const f = doc.fields || {};
          const serviceDocId = doc.name.split('/').pop();
          const lat = f.latitude?.doubleValue;
          const lng = f.longitude?.doubleValue;
          if (!serviceDocId || lat === undefined || lng === undefined) continue;

          matchedDocs.push({
            serviceDocId,
            busNo: f.vehicleNumber?.stringValue || f.busNumber?.stringValue || qUpper,
            oprsNo: f.oprsNo?.stringValue || '',
            depotName: f.depotName?.stringValue || '',
            serviceType: f.serviceType?.stringValue || 'ORDINARY',
            driverName: f.driverName?.stringValue || '',
            lat,
            lng,
            speed: parseFloat(f.speed?.stringValue || '0') || 0,
            bearing: f.locationBearing?.doubleValue || 0,
            altitude: f.locationAltitude?.doubleValue || 0,
            isOnline: f.isOnline?.stringValue === '1',
            locationTime: f.locationTime?.stringValue || null,
            refreshedAt: Number(f.refreshedAt?.integerValue || Date.now())
          });
        }
        break; // Match found on this field
      }
    } catch (err) {
      console.warn(`[searchBusTracking] Error querying field ${field}:`, err.message);
    }
  }

  return matchedDocs;
}

/**
 * Queries all tracking details for a specific depot today
 */
async function fetchTrackingByDepot(depotName) {
  const dates = getApsrtcDates();
  const dUpper = (depotName || '').trim().toUpperCase();
  if (!dUpper) return [];

  const query = {
    structuredQuery: {
      from: [{ collectionId: 'trackingDetailsV2' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'depotName' },
                op: 'EQUAL',
                value: { stringValue: dUpper }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: 'journeyDate' },
                op: 'EQUAL',
                value: { stringValue: dates.journeyDate }
              }
            }
          ]
        }
      },
      limit: 100
    }
  };

  try {
    const results = await requestJson(FIRESTORE_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: query,
      timeout: 15000
    });

    const docs = (Array.isArray(results) ? results : []).filter(r => r && r.document).map(r => r.document);
    return docs.map(doc => {
      const f = doc.fields || {};
      const serviceDocId = doc.name.split('/').pop();
      return {
        serviceDocId,
        busNo: f.vehicleNumber?.stringValue || f.busNumber?.stringValue || 'Unknown',
        oprsNo: f.oprsNo?.stringValue || '',
        depotName: f.depotName?.stringValue || dUpper,
        serviceType: f.serviceType?.stringValue || 'ORDINARY',
        driverName: f.driverName?.stringValue || '',
        lat: f.latitude?.doubleValue,
        lng: f.longitude?.doubleValue,
        speed: parseFloat(f.speed?.stringValue || '0') || 0,
        bearing: f.locationBearing?.doubleValue || 0,
        altitude: f.locationAltitude?.doubleValue || 0,
        isOnline: f.isOnline?.stringValue === '1',
        locationTime: f.locationTime?.stringValue || null,
        refreshedAt: Number(f.refreshedAt?.integerValue || Date.now())
      };
    }).filter(b => b.lat && b.lng && !isNaN(b.lat) && !isNaN(b.lng));
  } catch (err) {
    console.warn(`[fetchTrackingByDepot] Error fetching depot ${dUpper}:`, err.message);
    return [];
  }
}

module.exports = {
  getApsrtcDates,
  fetchMappedPlaces,
  fetchActiveTrips,
  fetchServiceDetails,
  fetchTrackingDetails,
  fetchBatchTrackingDetails,
  fetchLiveBusLocation,
  searchBusTracking,
  fetchTrackingByDepot,
  fetchServiceWaypointDetails,
  fetchAllServiceNumbers,
  encryptQueryToken
};

