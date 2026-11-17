// ============================================================================
// MAP & API CONFIGURATION
// ============================================================================
const MAP_CONFIG = {
  // Provider options: 'carto' (Default), 'osm', 'google', 'mapbox', 'maptiler'
  provider: 'carto',

  // The CARTO key is NOT stored here. It is loaded from the server (/api/config),
  // which reads it from the CARTO_API_KEY environment variable (.env locally,
  // Render's Environment tab when hosted).
  cartoApiKey: '',

  // CARTO Style options: 'voyager' (colorful), 'dark_matter' (dark theme), 'positron' (light theme)
  cartoStyle: 'voyager',

  // Other providers (if needed in future):
  googleMapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY',
  mapboxAccessToken: 'YOUR_MAPBOX_ACCESS_TOKEN',
  maptilerApiKey: 'YOUR_MAPTILER_API_KEY'
};

/**
 * Loads map settings from the backend. Never throws: if the config cannot be
 * loaded, the map still works because CARTO Voyager tiles do not require a key.
 */
async function loadMapConfig() {
  try {
    const response = await fetch('/api/config');

    if (!response.ok) {
      throw new Error(`Config request failed with status ${response.status}`);
    }

    const config = await response.json();
    MAP_CONFIG.cartoApiKey = config.cartoApiKey || '';

    console.log('Map configuration loaded successfully');
  } catch (error) {
    console.warn('Map configuration not loaded, continuing without a CARTO key:', error.message);
  }
}

// APSRTC Live Bus Tracker — Frontend Engine
let map;
let markerClusterGroup;
let routePolylineLayer = null;
let routeStopsLayerGroup = null;
let liveBusMarkerOnRoute = null;
let selectedBusLiveTimer = null;

let allBuses = [];
let filteredBuses = [];
let selectedBus = null;
let refreshCountdown = 25;
let countdownTimer = null;

// Andhra Pradesh coordinates center
const AP_CENTER = [16.3067, 80.4365];
const INITIAL_ZOOM = 8;

document.addEventListener('DOMContentLoaded', async () => {
  // Load config first so the map can use the key (if any) before it is created
  await loadMapConfig();
  initMap();
  setupEventListeners();
  fetchInitialData();
  startCountdown();
});

/**
 * Initializes Leaflet Map according to MAP_CONFIG
 */
function initMap() {
  map = L.map('map', {
    center: AP_CENTER,
    zoom: INITIAL_ZOOM,
    zoomControl: false
  });

  // Zoom control in bottom right
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Configure tile layer based on MAP_CONFIG
  let tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
  let attribution = '&copy; OpenStreetMap &copy; CARTO | APSRTC Live Track';

  if (MAP_CONFIG.provider === 'carto') {
    let stylePath = 'rastertiles/voyager';
    if (MAP_CONFIG.cartoStyle === 'dark_matter') stylePath = 'dark_all';
    else if (MAP_CONFIG.cartoStyle === 'positron') stylePath = 'light_all';

    const hasKey = MAP_CONFIG.cartoApiKey && MAP_CONFIG.cartoApiKey.trim() !== '' && !MAP_CONFIG.cartoApiKey.startsWith('YOUR_');
    tileUrl = `https://{s}.basemaps.cartocdn.com/${stylePath}/{z}/{x}/{y}{r}.png${hasKey ? `?key=${encodeURIComponent(MAP_CONFIG.cartoApiKey.trim())}` : ''}`;
    attribution = '&copy; OpenStreetMap &copy; CARTO | APSRTC Live Track';
  } else if (MAP_CONFIG.provider === 'mapbox' && MAP_CONFIG.mapboxAccessToken !== 'YOUR_MAPBOX_ACCESS_TOKEN') {
    tileUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAP_CONFIG.mapboxAccessToken}`;
    attribution = '&copy; Mapbox &copy; OpenStreetMap';
  } else if (MAP_CONFIG.provider === 'maptiler' && MAP_CONFIG.maptilerApiKey !== 'YOUR_MAPTILER_API_KEY') {
    tileUrl = `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAP_CONFIG.maptilerApiKey}`;
    attribution = '&copy; MapTiler &copy; OpenStreetMap';
  } else if (MAP_CONFIG.provider === 'osm') {
    tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    attribution = '&copy; OpenStreetMap contributors';
  } else if (MAP_CONFIG.provider === 'google' && MAP_CONFIG.googleMapsApiKey !== 'YOUR_GOOGLE_MAPS_API_KEY') {
    tileUrl = `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${MAP_CONFIG.googleMapsApiKey}`;
    attribution = '&copy; Google Maps';
  }

  L.tileLayer(tileUrl, {
    attribution,
    maxZoom: 19,
    subdomains: 'abcd'
  }).addTo(map);

  // Initialize Marker Cluster Group
  markerClusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 14
  });
  map.addLayer(markerClusterGroup);

  routeStopsLayerGroup = L.layerGroup().addTo(map);
}

/**
 * Setup UI event listeners
 */
function setupEventListeners() {
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearch');
  const depotFilter = document.getElementById('depotFilter');
  const typeFilter = document.getElementById('typeFilter');
  const refreshBtn = document.getElementById('refreshBtn');
  const toggleListBtn = document.getElementById('toggleListBtn');
  const closeFleetDrawer = document.getElementById('closeFleetDrawer');
  const closeDetailDrawer = document.getElementById('closeDetailDrawer');

  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    clearBtn.style.display = val ? 'block' : 'none';
    applyFilters();
    triggerServerSearchDebounced(val);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) triggerServerSearch(val);
    }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    applyFilters();
  });

  depotFilter.addEventListener('change', async (e) => {
    const depot = e.target.value;
    if (depot) {
      await fetchDepotBuses(depot);
    }
    applyFilters();
  });
  typeFilter.addEventListener('change', applyFilters);

  refreshBtn.addEventListener('click', () => {
    triggerManualRefresh();
  });

  toggleListBtn.addEventListener('click', () => {
    document.getElementById('fleetDrawer').classList.toggle('open');
  });

  closeFleetDrawer.addEventListener('click', () => {
    document.getElementById('fleetDrawer').classList.remove('open');
  });

  closeDetailDrawer.addEventListener('click', () => {
    document.getElementById('busDetailDrawer').classList.remove('open');
    clearRouteLayers();
    stopSelectedBusLivePoll();
    selectedBus = null;
  });

  // Listen for hash changes (e.g. user navigating to #/trip_details?... or #/track?...)
  window.addEventListener('hashchange', () => {
    checkUrlParamsForTracking();
  });

  // Toggle map legend
  const toggleLegendBtn = document.getElementById('toggleLegendBtn');
  const mapLegend = document.getElementById('mapLegend');
  if (toggleLegendBtn && mapLegend) {
    toggleLegendBtn.addEventListener('click', () => {
      mapLegend.classList.toggle('collapsed');
    });
  }
}

/**
 * Fetches live buses and statistics from backend API
 */
async function fetchInitialData() {
  await Promise.all([
    fetchLiveBuses(),
    fetchStats()
  ]);
  checkUrlParamsForTracking();
}

/**
 * Checks URL query parameters or hash to auto-open specific bus tracking
 * Supports ?serviceDocId=..., ?bus=..., #/track?serviceDocId=..., #/trip_details?serviceDocId=...&oprsNo=...
 */
async function checkUrlParamsForTracking() {
  const urlParams = new URLSearchParams(window.location.search);
  let docId = urlParams.get('serviceDocId') || urlParams.get('docId');
  let busNo = urlParams.get('bus') || urlParams.get('busNo');
  let oprsNo = urlParams.get('oprsNo');

  if (window.location.hash) {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    if (qIndex !== -1) {
      const hashParams = new URLSearchParams(hash.substring(qIndex + 1));
      docId = docId || hashParams.get('serviceDocId') || hashParams.get('docId');
      busNo = busNo || hashParams.get('bus') || hashParams.get('busNo');
      oprsNo = oprsNo || hashParams.get('oprsNo');
    }
  }

  const target = docId || busNo || oprsNo;
  if (!target) return;

  // Search in loaded buses or fetch from backend API
  let bus = allBuses.find(b =>
    (docId && b.serviceDocId === docId) ||
    (busNo && b.busNo && b.busNo.toLowerCase() === busNo.toLowerCase()) ||
    (oprsNo && b.oprsNo && b.oprsNo.toLowerCase() === oprsNo.toLowerCase())
  );

  if (!bus) {
    try {
      const endpoint = docId
        ? `/api/buses/live?docId=${encodeURIComponent(docId)}`
        : `/api/buses/live?search=${encodeURIComponent(target)}`;
      const res = await fetch(endpoint);
      const data = await res.json();
      if (data.success && data.buses && data.buses.length > 0) {
        bus = data.buses[0];
        allBuses.unshift(bus);
        applyFilters();
      }
    } catch (e) {
      console.warn('Could not auto-track target from URL:', e);
    }
  }

  if (bus) {
    selectBus(bus, true);
    traceFullRoute(bus.serviceDocId);
  }
}

async function fetchLiveBuses(silent = false) {
  const statusText = document.getElementById('activeCountText');
  if (!silent) statusText.innerText = 'Syncing live fleet...';

  try {
    const res = await fetch('/api/buses/live');
    const data = await res.json();

    if (data.success && Array.isArray(data.buses)) {
      allBuses = data.buses;
      const liveGpsCount = allBuses.filter(b => b.isLiveGps).length;
      statusText.innerText = `${allBuses.length} Buses (${liveGpsCount} Live GPS Fixes)`;
      document.getElementById('statTotalBuses').innerText = allBuses.length;

      populateFilterDropdowns();
      applyFilters();
    }
  } catch (err) {
    console.error('Failed to fetch buses:', err);
    statusText.innerText = 'Sync failed. Retrying...';
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/buses/stats');
    const data = await res.json();
    if (data.success && data.stats) {
      document.getElementById('statDepots').innerText = data.stats.depotsCount || '-';
      document.getElementById('statRoutes').innerText = data.stats.routesCount || '-';
      if (data.stats.lastSync) {
        const d = new Date(data.stats.lastSync);
        document.getElementById('statLastSync').innerText = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

/**
 * Populates Depots and Service Types dropdowns
 */
function populateFilterDropdowns() {
  const depotFilter = document.getElementById('depotFilter');
  const typeFilter = document.getElementById('typeFilter');

  const currentDepot = depotFilter.value;
  const currentType = typeFilter.value;

  const depots = new Set();
  const types = new Set();

  for (const b of allBuses) {
    if (b.depotName) depots.add(b.depotName);
    if (b.serviceType) types.add(b.serviceType);
  }

  // Populate Depots
  depotFilter.innerHTML = '<option value="">All Depots</option>';
  Array.from(depots).sort().forEach(depot => {
    const opt = document.createElement('option');
    opt.value = depot;
    opt.textContent = depot;
    if (depot === currentDepot) opt.selected = true;
    depotFilter.appendChild(opt);
  });

  // Populate Service Types
  typeFilter.innerHTML = '<option value="">All Service Types</option>';
  Array.from(types).sort().forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = type;
    if (type === currentType) opt.selected = true;
    typeFilter.appendChild(opt);
  });
}

/**
 * Filters the fleet based on search query and dropdown selections
 */
function applyFilters() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const selectedDepot = document.getElementById('depotFilter').value;
  const selectedType = document.getElementById('typeFilter').value;

  filteredBuses = allBuses.filter(b => {
    if (selectedDepot && b.depotName !== selectedDepot) return false;
    if (selectedType && b.serviceType !== selectedType) return false;

    if (query) {
      const matchNo = b.busNo && b.busNo.toLowerCase().includes(query);
      const matchOprs = b.oprsNo && b.oprsNo.toLowerCase().includes(query);
      const matchRoute = b.routeName && b.routeName.toLowerCase().includes(query);
      const matchSrc = b.sourceName && b.sourceName.toLowerCase().includes(query);
      const matchDest = b.destinationName && b.destinationName.toLowerCase().includes(query);
      const matchStop = b.currentStop && b.currentStop.toLowerCase().includes(query);
      return matchNo || matchOprs || matchRoute || matchSrc || matchDest || matchStop;
    }
    return true;
  });

  renderMapMarkers();
  renderFleetDrawerList();
}

let searchDebounceTimer = null;
function triggerServerSearchDebounced(query) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!query || query.length < 2) return;
  searchDebounceTimer = setTimeout(() => {
    triggerServerSearch(query);
  }, 400);
}

async function triggerServerSearch(query) {
  if (!query || query.length < 2) return;
  const statusText = document.getElementById('activeCountText');
  const prevText = statusText ? statusText.innerText : '';
  if (statusText) statusText.innerText = `Searching Firestore for "${query}"...`;

  try {
    const res = await fetch(`/api/buses/live?search=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.success && Array.isArray(data.buses) && data.buses.length > 0) {
      let addedCount = 0;
      for (const b of data.buses) {
        if (!allBuses.some(existing => existing.serviceDocId === b.serviceDocId)) {
          allBuses.unshift(b);
          addedCount++;
        }
      }
      populateFilterDropdowns();
      applyFilters();
      if (statusText) statusText.innerText = `${data.buses.length} match found for "${query}"`;

      // If exactly 1 match or searched specific serviceDocId, select it and focus map
      if (data.buses.length === 1 && (!selectedBus || selectedBus.serviceDocId !== data.buses[0].serviceDocId)) {
        selectBus(data.buses[0], true);
      }
      return;
    }
  } catch (err) {
    console.warn('Server search failed:', err);
  }
  if (statusText) statusText.innerText = prevText;
}

async function fetchDepotBuses(depotName) {
  const statusText = document.getElementById('activeCountText');
  if (statusText) statusText.innerText = `Loading buses for ${depotName}...`;
  try {
    const res = await fetch(`/api/buses/live?depot=${encodeURIComponent(depotName)}`);
    const data = await res.json();
    if (data.success && Array.isArray(data.buses)) {
      for (const b of data.buses) {
        if (!allBuses.some(existing => existing.serviceDocId === b.serviceDocId)) {
          allBuses.unshift(b);
        }
      }
      populateFilterDropdowns();
      applyFilters();
      if (statusText) statusText.innerText = `${data.buses.length} buses active in ${depotName}`;
    }
  } catch (e) {
    console.warn('Could not fetch depot buses:', e);
  }
}

/**
 * Resolves standard APSRTC bus service category
 * City Ordinary: Red, Metro Express: Blue, Palle Velugu: Green,
 * Intercity Express: Orange, Super Luxury: Purple, Ultra Deluxe: Teal,
 * Saptagiri: Yellow/Gold, Indra AC: Sky Blue, Amaravathi/Garuda: Bronze Gold,
 * Green EV: Emerald
 */
function getBusServiceCategory(serviceType) {
  const st = (serviceType || '').toLowerCase();
  if (st.includes('metro express')) return 'metro-express';
  if (st.includes('city ordinary') || st.includes('ordinary')) return 'city-ordinary';
  if (st.includes('palle') || st.includes('velugu')) return 'pallevelugu';
  if (st.includes('super luxury')) return 'super-luxury';
  if (st.includes('ultra deluxe')) return 'ultra-deluxe';
  if (st.includes('green saptagiri') || st.includes('ev')) return 'green-ev';
  if (st.includes('saptagiri')) return 'saptagiri';
  if (st.includes('indra')) return 'indra-ac';
  if (st.includes('amaravathi') || st.includes('dolphin') || st.includes('garuda') || st.includes('multiaxle')) return 'amaravathi-luxury';
  if (st.includes('metro luxury') || st.includes('aero')) return 'metro-luxury';
  if (st.includes('express')) return 'express';
  return 'other';
}

/**
 * Creates custom colored bus marker icon
 */
function createBusIcon(serviceType, isLiveGps = false, speed = 0, bearing = 0) {
  const category = getBusServiceCategory(serviceType);
  const pinClass = `pin-${category}`;

  const isMoving = isLiveGps && speed > 2;
  const liveClass = isLiveGps ? (isMoving ? 'live-gps is-moving' : 'live-gps') : '';
  const arrowHtml = isMoving && bearing ? `<div class="pin-heading-arrow" style="transform: translateX(-50%) rotate(${bearing}deg)"></div>` : '';

  return L.divIcon({
    className: 'custom-bus-icon-wrapper',
    html: `<div class="custom-bus-pin ${pinClass} ${liveClass}">
      ${arrowHtml}
      <i class="fa-solid fa-bus"></i>
    </div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -18]
  });
}

/**
 * Renders markers onto Leaflet Map
 */
function renderMapMarkers() {
  markerClusterGroup.clearLayers();

  const markers = [];

  for (const bus of filteredBuses) {
    if (!bus.lat || !bus.lng) continue;

    const marker = L.marker([bus.lat, bus.lng], {
      icon: createBusIcon(bus.serviceType, bus.isLiveGps, bus.speed, bus.bearing),
      title: `${bus.busNo} (${bus.routeName})`
    });

    const speedBadge = bus.isLiveGps
      ? (bus.speed > 2
          ? `<span class="speed-tag"><span class="live-pulse-indicator"></span> ${bus.speed.toFixed(1)} km/h</span>`
          : `<span class="speed-tag stopped"><span class="live-pulse-indicator" style="background:#94a3b8;box-shadow:none;"></span> Stopped (0 km/h)</span>`)
      : `<span class="speed-tag stopped">Station Estimate</span>`;

    const popupHtml = `
      <div class="popup-container">
        <div class="popup-header">
          <span class="popup-bus-no">${bus.busNo}</span>
          <span class="bus-badge ${getBadgeClass(bus.serviceType)}">${bus.serviceType}</span>
        </div>
        <div style="margin-bottom:6px;">${speedBadge}</div>
        <div class="popup-route">${bus.sourceName || 'Origin'} &rarr; ${bus.destinationName || 'Destination'}</div>
        <div class="popup-stop">
          <i class="fa-solid fa-location-dot" style="color:#10b981"></i>
          <strong>${bus.isLiveGps ? 'Nearest Stop / Area:' : 'Current Stop:'}</strong> ${bus.currentStop || 'In Transit'}
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">
          Depot: <strong>${bus.depotName}</strong> | Service: <strong>${bus.oprsNo}</strong>
        </div>
        <button class="popup-btn" onclick="selectBusById('${bus.id}')">
          <i class="fa-solid fa-circle-info"></i> View Details & Trace Route
        </button>
      </div>
    `;

    marker.bindPopup(popupHtml);
    marker.on('click', () => {
      selectBus(bus, false);
    });

    markers.push(marker);
  }

  markerClusterGroup.addLayers(markers);
}

/**
 * Renders the fleet list inside the left off-canvas drawer
 */
function renderFleetDrawerList() {
  const container = document.getElementById('busListContainer');
  document.getElementById('drawerCount').innerText = filteredBuses.length;

  if (filteredBuses.length === 0) {
    container.innerHTML = `
      <div class="loading-state">
        <i class="fa-solid fa-bus"></i>
        <p>No active buses found matching filter.</p>
      </div>
    `;
    return;
  }

  const itemsHtml = filteredBuses.map(bus => `
    <div class="bus-list-item" onclick="selectBusById('${bus.id}')">
      <div class="bus-item-top">
        <span class="bus-item-no">${bus.busNo}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${bus.isLiveGps ? `<span class="speed-tag ${bus.speed > 2 ? '' : 'stopped'}">${bus.speed > 2 ? bus.speed.toFixed(0) + ' km/h' : '0 km/h'}</span>` : ''}
          <span class="bus-badge ${getBadgeClass(bus.serviceType)}">${bus.serviceType}</span>
        </div>
      </div>
      <div class="bus-item-route">${bus.sourceName || 'Origin'} &rarr; ${bus.destinationName || 'Destination'}</div>
      <div class="bus-item-meta">
        <span><i class="fa-solid fa-location-dot"></i> ${bus.currentStop || 'In transit'}</span>
        <span>${bus.depotName}</span>
      </div>
    </div>
  `).join('');

  container.innerHTML = itemsHtml;
}

/**
 * Selects a bus and opens right detail drawer
 */
window.selectBusById = function(busId) {
  const bus = allBuses.find(b => b.id === busId);
  if (bus) {
    selectBus(bus, true);
  }
};

function selectBus(bus, flyTo = true) {
  selectedBus = bus;
  stopSelectedBusLivePoll();

  const drawer = document.getElementById('busDetailDrawer');
  drawer.classList.add('open');

  if (flyTo && bus.lat && bus.lng) {
    map.flyTo([bus.lat, bus.lng], 14, { duration: 1.2 });
  }

  updateBusDetailDrawerUI(bus);
  startSelectedBusLivePoll(bus.serviceDocId);
}

function updateBusDetailDrawerUI(bus) {
  const content = document.getElementById('busDetailContent');
  if (!content) return;

  content.innerHTML = `
    <div class="detail-hero">
      <div class="detail-bus-no">
        <span>${bus.busNo}</span>
        <span class="bus-badge ${getBadgeClass(bus.serviceType)}">${bus.serviceType}</span>
      </div>
      <div class="detail-route-title">${bus.sourceName && bus.destinationName ? `${bus.sourceName} &rarr; ${bus.destinationName}` : (bus.sourceName ? `${bus.sourceName} &rarr; End` : (bus.routeName || 'Live Trip Route'))}</div>
      <div class="detail-depot"><i class="fa-solid fa-warehouse"></i> ${bus.depotName} Depot &bull; Service #${bus.oprsNo}</div>
    </div>

    ${bus.isLiveGps ? `
      <div class="detail-live-banner">
        <div class="live-label">
          <span class="live-pulse-indicator"></span>
          <span>REAL-TIME GPS FIX ACTIVE</span>
        </div>
        <div class="live-speed-val">${bus.speed > 2 ? bus.speed.toFixed(1) + ' km/h' : '0.0 km/h'}</div>
      </div>
    ` : `
      <div class="detail-live-banner" style="background:rgba(148,163,184,0.1);border-color:rgba(148,163,184,0.3);">
        <div class="live-label" style="color:#94a3b8;">
          <i class="fa-solid fa-clock"></i>
          <span>SCHEDULE / STATION ESTIMATE</span>
        </div>
        <div class="live-speed-val" style="color:#94a3b8;font-size:12px;">Waiting GPS Fix</div>
      </div>
    `}

    <div class="detail-grid">
      <div class="detail-card highlight">
        <div class="detail-card-label">Current Location / Stop</div>
        <div class="detail-card-val"><i class="fa-solid fa-location-crosshairs"></i> ${bus.currentStop}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
          GPS: ${bus.lat ? bus.lat.toFixed(6) : '-'}, ${bus.lng ? bus.lng.toFixed(6) : '-'}
          ${bus.bearing ? ` &bull; Heading: ${bus.bearing.toFixed(0)}°` : ''}
        </div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Real-Time Speed</div>
        <div class="detail-card-val live-speed-text" style="color:${bus.speed > 2 ? '#34d399' : '#fff'};">
          ${bus.isLiveGps ? `${bus.speed.toFixed(1)} km/h` : 'N/A'}
        </div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Compass Heading</div>
        <div class="detail-card-val live-bearing-text">${bus.bearing ? `${bus.bearing.toFixed(0)}°` : 'N/A'}</div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Schedule Start</div>
        <div class="detail-card-val">${bus.startTime || 'Scheduled'}</div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Schedule End</div>
        <div class="detail-card-val">${bus.endTime || 'Scheduled'}</div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Driver Assigned</div>
        <div class="detail-card-val">${bus.driverName || 'APSRTC Crew'}</div>
      </div>

      <div class="detail-card">
        <div class="detail-card-label">Driver Contact</div>
        <div class="detail-card-val">${bus.driverMobile ? `<a href="tel:${bus.driverMobile}" style="color:#38bdf8;text-decoration:none;">${bus.driverMobile}</a>` : 'Not Available'}</div>
      </div>

      <div class="detail-card highlight">
        <div class="detail-card-label">GPS Last Refreshed</div>
        <div class="detail-card-val" style="color:#cbd5e1;font-size:12px;" id="liveRefreshedText">
          ${bus.refreshedAt || (bus.refreshedTimestamp ? new Date(bus.refreshedTimestamp).toLocaleTimeString() : 'Live via UTS')}
        </div>
      </div>
    </div>

    <button class="route-trace-btn" id="traceRouteBtn" onclick="traceFullRoute('${bus.serviceDocId}')">
      <i class="fa-solid fa-route"></i> Trace Full Route & Waypoints
    </button>

    <div id="routeTimelineContainer"></div>
  `;
}

function startSelectedBusLivePoll(serviceDocId) {
  stopSelectedBusLivePoll();

  selectedBusLiveTimer = setInterval(async () => {
    if (!selectedBus || selectedBus.serviceDocId !== serviceDocId) {
      stopSelectedBusLivePoll();
      return;
    }

    try {
      const res = await fetch(`/api/buses/live-location?docId=${encodeURIComponent(serviceDocId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.live) {
        const live = data.live;
        selectedBus.lat = live.lat;
        selectedBus.lng = live.lng;
        selectedBus.speed = live.speed;
        selectedBus.bearing = live.bearing;
        selectedBus.isLiveGps = true;
        selectedBus.refreshedAt = new Date(live.refreshedAt).toLocaleTimeString();
        selectedBus.refreshedTimestamp = live.refreshedAt;

        // Update in-memory allBuses object
        const match = allBuses.find(b => b.serviceDocId === serviceDocId);
        if (match) {
          match.lat = live.lat;
          match.lng = live.lng;
          match.speed = live.speed;
          match.bearing = live.bearing;
          match.isLiveGps = true;
        }

        // Move live bus marker along the route if traced
        if (liveBusMarkerOnRoute) {
          liveBusMarkerOnRoute.setLatLng([live.lat, live.lng]);
          liveBusMarkerOnRoute.setPopupContent(`
            <strong>${selectedBus.busNo} (LIVE)</strong><br>
            Speed: <strong>${live.speed.toFixed(1)} km/h</strong><br>
            Heading: <strong>${live.bearing.toFixed(0)}°</strong>
          `);
        }

        // Live update drawer stats without resetting route timeline
        const speedVal = document.querySelector('.live-speed-val');
        if (speedVal) speedVal.innerText = `${live.speed > 2 ? live.speed.toFixed(1) + ' km/h' : '0.0 km/h'}`;
        const speedText = document.querySelector('.live-speed-text');
        if (speedText) speedText.innerText = `${live.speed.toFixed(1)} km/h`;
        const bearingText = document.querySelector('.live-bearing-text');
        if (bearingText) bearingText.innerText = `${live.bearing.toFixed(0)}°`;
        const refText = document.getElementById('liveRefreshedText');
        if (refText) refText.innerText = selectedBus.refreshedAt;
      }
    } catch (e) {
      console.warn('Live poll error for bus:', e);
    }
  }, 6000); // 6 seconds live poll just like apsrtclivetrack
}

function stopSelectedBusLivePoll() {
  if (selectedBusLiveTimer) {
    clearInterval(selectedBusLiveTimer);
    selectedBusLiveTimer = null;
  }
}

/**
 * Traces full stop-by-stop route polyline on map
 */
window.traceFullRoute = async function(serviceDocId) {
  const btn = document.getElementById('traceRouteBtn');
  const timeline = document.getElementById('routeTimelineContainer');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching Live GPS Waypoints...';
  }

  try {
    const res = await fetch(`/api/buses/route?docId=${encodeURIComponent(serviceDocId)}`);
    const data = await res.json();

    if (!data.success || !data.route || data.route.stops.length === 0) {
      if (timeline) {
        timeline.innerHTML = '<p style="color:#94a3b8;font-size:12px;margin-top:10px;">No waypoint history available for this trip yet.</p>';
      }
      return;
    }

    const { stops, polyline } = data.route;

    // Route title fallback from waypoints if sourceName or destinationName are missing or placeholder
    if (stops && stops.length > 0 && selectedBus) {
      const firstStop = stops[0].name;
      const lastStop = stops[stops.length - 1].name;
      if (!selectedBus.sourceName || selectedBus.sourceName === 'Start') {
        selectedBus.sourceName = firstStop;
      }
      if (!selectedBus.destinationName || selectedBus.destinationName === 'End') {
        selectedBus.destinationName = lastStop;
      }
      const titleEl = document.querySelector('.detail-route-title');
      if (titleEl && selectedBus.sourceName && selectedBus.destinationName) {
        titleEl.innerHTML = `${selectedBus.sourceName} &rarr; ${selectedBus.destinationName}`;
      }
    }

    // Clear any previous route layers
    clearRouteLayers();

    // Draw route polyline with bright cyan line
    routePolylineLayer = L.polyline(polyline, {
      color: '#06b6d4',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);

    // Add stop pins
    stops.forEach((stop, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === stops.length - 1;
      let pinColor = '#94a3b8'; // upcoming

      if (stop.hasDeparted) pinColor = '#10b981'; // passed
      else if (isFirst) pinColor = '#10b981';
      else if (isLast) pinColor = '#ef4444';

      const circle = L.circleMarker([stop.lat, stop.lng], {
        radius: isFirst || isLast ? 8 : 5,
        fillColor: pinColor,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      }).bindPopup(`
        <strong>${stop.name}</strong> (${stop.placeCode})<br>
        Seq: #${stop.seqNo}<br>
        Schedule: ${stop.scheduleTime || 'N/A'}<br>
        Status: ${stop.hasDeparted ? 'Passed' : 'Upcoming'}
      `);

      routeStopsLayerGroup.addLayer(circle);
    });

    // Fit map bounds to show full route
    map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });

    // Add prominent real-time bus marker on the route
    if (selectedBus && selectedBus.lat && selectedBus.lng) {
      const liveBusIcon = L.divIcon({
        className: 'live-route-bus-wrapper',
        html: `
          <div class="live-route-bus-icon">
            <i class="fa-solid fa-bus"></i>
          </div>
        `,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
        popupAnchor: [0, -20]
      });

      liveBusMarkerOnRoute = L.marker([selectedBus.lat, selectedBus.lng], {
        icon: liveBusIcon,
        zIndexOffset: 1500
      }).bindPopup(`
        <strong>${selectedBus.busNo} (LIVE)</strong><br>
        Speed: <strong>${selectedBus.speed ? selectedBus.speed.toFixed(1) : 0} km/h</strong><br>
        Status: <strong>${selectedBus.speed > 2 ? 'Moving' : 'Idle / Stop'}</strong>
      `);

      routeStopsLayerGroup.addLayer(liveBusMarkerOnRoute);
    }

    // Render timeline in right drawer
    if (timeline) {
      timeline.innerHTML = `
        <div class="waypoints-timeline">
          <div class="timeline-title">
            <i class="fa-solid fa-signs-post"></i>
            <span>Trip Waypoints (${stops.length} Stops)</span>
          </div>
          <div class="timeline-list">
            ${stops.map(s => {
              const statusClass = s.hasDeparted ? 'passed' : '';
              return `
                <div class="timeline-item ${statusClass}">
                  <div class="timeline-dot"></div>
                  <div class="timeline-stop-name">${s.name}</div>
                  <div class="timeline-stop-meta">
                    Scheduled: ${s.scheduleTime || '--:--'}
                    ${s.vtsDepartureTime ? ` &bull; Departed: ${s.vtsDepartureTime}` : ''}
                    ${s.eta ? ` &bull; ETA: ${s.eta}` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }
  } catch (err) {
    console.error('Error tracing route:', err);
    if (timeline) {
      timeline.innerHTML = '<p style="color:#ef4444;font-size:12px;">Failed to load route waypoints.</p>';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-route"></i> Trace Full Route & Waypoints';
    }
  }
};

function clearRouteLayers() {
  if (routePolylineLayer) {
    map.removeLayer(routePolylineLayer);
    routePolylineLayer = null;
  }
  if (routeStopsLayerGroup) {
    routeStopsLayerGroup.clearLayers();
  }
  liveBusMarkerOnRoute = null;
}

function getBadgeClass(type) {
  return getBusServiceCategory(type);
}

/**
 * 25-second countdown timer for auto-polling
 */
function startCountdown() {
  const timerSpan = document.getElementById('refreshTimer');
  refreshCountdown = 25;

  if (countdownTimer) clearInterval(countdownTimer);

  countdownTimer = setInterval(() => {
    refreshCountdown--;
    if (timerSpan) timerSpan.innerText = `${refreshCountdown}s`;

    if (refreshCountdown <= 0) {
      refreshCountdown = 25;
      fetchLiveBuses(true);
      fetchStats();
    }
  }, 1000);
}

function triggerManualRefresh() {
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.classList.add('fa-spin');

  fetch('/api/buses/refresh', { method: 'POST' })
    .then(res => res.json())
    .then(() => {
      fetchLiveBuses(false);
      fetchStats();
      startCountdown();
    })
    .catch(err => console.error('Manual refresh error:', err))
    .finally(() => {
      setTimeout(() => {
        if (icon) icon.classList.remove('fa-spin');
      }, 1000);
    });
}