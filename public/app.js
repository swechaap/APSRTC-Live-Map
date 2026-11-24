// ============================================================================
// MAP & API CONFIGURATION
// ============================================================================
const MAP_CONFIG = {
  // Provider options: 'carto' (Default), 'osm', 'google', 'mapbox', 'maptiler'
  provider: 'carto',

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
let knownFilters = { depots: [], serviceTypes: [] };
let filteredBuses = [];
let selectedBus = null;
let refreshCountdown = 25;
let countdownTimer = null;
let riderFilter = null;
let riderRequestVersion = 0;
let riderStopMarker = null;
let updateRiderFilter;
let saveRecentSearch = () => {};

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

  setupRiderSearch();
  setupRoutes();

  const filtersToggle = document.getElementById('filtersToggle');
  filtersToggle.addEventListener('click', () => {
    const open = document.getElementById('filterGroup').classList.toggle('open');
    filtersToggle.setAttribute('aria-expanded', String(open));
  });
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

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      triggerManualRefresh();
    });
  }

  function setupRoutes() {
    const panel = document.getElementById('routesPanel');
    const toggle = document.getElementById('routesBtn');
    const input = document.getElementById('routeQuery');
    const chips = document.getElementById('routeCityChips');
    const status = document.getElementById('routeStatus');
    const results = document.getElementById('routeResults');
    const listView = document.getElementById('routesListView');
    const detailView = document.getElementById('routeDetailView');
    const detailBody = document.getElementById('routeDetailBody');
    let city = '';
    let timer = null;
    let version = 0;
    let loadedCities = false;
    let currentRoute = null;
    let detailTimer = null;

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function setOpen(open) {
      if (open) {
        const rider = document.getElementById('riderSearchPanel');
        rider.hidden = true;
        document.getElementById('riderSearchBtn').setAttribute('aria-expanded', 'false');
        document.getElementById('fleetDrawer').classList.remove('open');
        document.getElementById('busDetailDrawer').classList.remove('open');
        document.body.classList.remove('drawer-open');
        document.getElementById('toggleListBtn').setAttribute('aria-expanded', 'false');
        stopSelectedBusLivePoll();
        selectedBus = null;
        if (!loadedCities) search();
      } else {
        stopDetailRefresh();
      }
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    }
    window.closeRoutesPanel = () => setOpen(false);

    function renderChips(cities) {
      const items = [{ name: '', label: 'All' }, ...cities.map(c => ({ name: c.name, label: c.name }))];
      chips.innerHTML = items.map(c =>
        `<button type="button" data-city="${esc(c.name)}" class="${c.name === city ? 'active' : ''}">${esc(c.label)}</button>`
      ).join('');
    }

    async function search() {
      const v = ++version;
      status.textContent = 'Searching routes...';
      try {
        const params = new URLSearchParams({ q: input.value.trim(), city });
        const res = await fetch(`/api/routes?${params}`);
        const data = await res.json();
        if (v !== version) return;
        if (!data.success) throw new Error('bad response');
        if (!loadedCities) { loadedCities = true; renderChips(data.cities); }
        status.textContent = data.total
          ? `${data.total} route${data.total === 1 ? '' : 's'}${data.total > data.routes.length ? ` (showing ${data.routes.length})` : ''}`
          : 'No routes found. Try a route number like 28A or a place name.';
        results.innerHTML = data.routes.map(r => `
          <li><button type="button" data-id="${esc(r.id)}">
            <span class="route-no ${r.kind === 'City' ? 'city' : ''}">${esc(r.no)}</span>
            <span class="route-info">
              <strong>${esc(r.name)}</strong>
              <small>${esc(r.city ? `${r.city} · ` : '')}${esc(r.type || r.kind)} · ${r.trips} trips/day</small>
            </span>
          </button></li>`).join('');
      } catch (err) {
        if (v !== version) return;
        status.textContent = 'Could not load routes. Please try again.';
      }
    }

    function stopDetailRefresh() {
      if (detailTimer) clearInterval(detailTimer);
      detailTimer = null;
    }

    function drawRoute(route, liveBuses, fit) {
      clearRouteLayers();
      const line = route.shape.length > 1 ? route.shape : route.stops.map(s => [s[1], s[2]]);
      routePolylineLayer = L.polyline(line, { color: '#0f766e', weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(map);
      route.stops.forEach((s, i) => {
        const end = i === 0 || i === route.stops.length - 1;
        routeStopsLayerGroup.addLayer(L.circleMarker([s[1], s[2]], {
          radius: end ? 8 : 5,
          fillColor: i === 0 ? '#10b981' : (end ? '#ef4444' : '#ffffff'),
          color: '#0f766e',
          weight: 2,
          fillOpacity: 1
        }).bindPopup(`<strong>${esc(s[0])}</strong><br>Stop ${i + 1} of ${route.stops.length}${s[3] ? `<br>Scheduled ${esc(s[3])}` : ''}`));
      });
      liveBuses.forEach(b => {
        if (!b.lat || !b.lng) return;
        const icon = L.divIcon({
          className: 'live-route-bus-wrapper',
          html: '<div class="live-route-bus-icon"><i class="fa-solid fa-bus"></i></div>',
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        });
        routeStopsLayerGroup.addLayer(L.marker([b.lat, b.lng], { icon, zIndexOffset: 1500 })
          .bindPopup(`<strong>${esc(b.busNo)} (LIVE)</strong><br>${esc(b.sourceName)} &rarr; ${esc(b.destinationName)}<br>Speed ${Math.round(b.speed || 0)} km/h`));
      });
      if (fit) {
        const mobile = window.innerWidth <= 768;
        const h = map.getSize ? map.getSize().y : window.innerHeight;
        map.fitBounds(routePolylineLayer.getBounds(), mobile
          ? { paddingTopLeft: [20, 20], paddingBottomRight: [20, Math.round(h * 0.55)] }
          : { paddingTopLeft: [420, 40], paddingBottomRight: [40, 40] });
      }
    }

    function renderDetail(route, liveBuses) {
      const first = route.stops[0]?.[0] || '';
      const last = route.stops[route.stops.length - 1]?.[0] || '';
      detailBody.innerHTML = `
        <div class="route-detail-head">
          <span class="route-no ${route.kind === 'City' ? 'city' : ''}">${esc(route.no)}</span>
          <div><strong>${esc(first)} &rarr; ${esc(last)}</strong>
          <small>${esc(route.city ? `${route.city} · ` : '')}${esc(route.type || route.kind)} · ${route.trips} trips/day</small></div>
        </div>
        <h3>Live now <span>${liveBuses.length} bus${liveBuses.length === 1 ? '' : 'es'}</span></h3>
        ${liveBuses.length ? `<ul class="route-live">${liveBuses.slice(0, 20).map((b, i) => `
          <li><button type="button" data-bus="${i}">
            <strong>${esc(b.busNo)}</strong>
            <small>${esc(b.currentStop || 'In transit')} · ${Math.round(b.speed || 0)} km/h</small>
          </button></li>`).join('')}</ul>` : '<p class="route-muted">No live bus found for this number right now. The line below is the scheduled route.</p>'}
        <h3>Departures <span>from ${esc(first)}</span></h3>
        <div class="route-deps">${route.deps.map(d => `<span>${esc(d)}</span>`).join('') || '<span>--</span>'}</div>
        <h3>Stops <span>${route.stops.length}</span></h3>
        <ol class="route-stops">${route.stops.map((s, i) => `
          <li data-stop="${i}"><span>${esc(s[0])}</span><small>${esc(s[3] || '')}</small></li>`).join('')}</ol>
        <p class="route-muted">Route and timings from the open APSRTC GTFS feed (reclaim.city). Live positions match buses by route number.</p>`;
      detailBody.querySelectorAll('[data-bus]').forEach(btn => btn.addEventListener('click', () => {
        const bus = liveBuses[Number(btn.dataset.bus)];
        const full = allBuses.find(b => b.serviceDocId === bus.serviceDocId) || bus;
        setOpen(false);
        selectBus(full);
      }));
      detailBody.querySelectorAll('[data-stop]').forEach(li => li.addEventListener('click', () => {
        const s = route.stops[Number(li.dataset.stop)];
        map.flyTo([s[1], s[2]], 15, { duration: 0.8 });
      }));
    }

    async function openRoute(id, fit = true) {
      try {
        const res = await fetch(`/api/routes/detail?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'failed');
        if (id !== (currentRoute && currentRoute.id) && !fit) return;
        currentRoute = data.route;
        listView.hidden = true;
        detailView.hidden = false;
        renderDetail(data.route, data.liveBuses);
        drawRoute(data.route, data.liveBuses, fit);
        stopDetailRefresh();
        detailTimer = setInterval(() => refreshLive(), 25000);
      } catch (err) {
        status.textContent = 'Could not load that route.';
      }
    }

    async function refreshLive() {
      if (!currentRoute || panel.hidden) return;
      try {
        const res = await fetch(`/api/routes/detail?id=${encodeURIComponent(currentRoute.id)}`);
        const data = await res.json();
        if (data.success && currentRoute && data.route.id === currentRoute.id) {
          renderDetail(data.route, data.liveBuses);
          drawRoute(data.route, data.liveBuses, false);
        }
      } catch (err) { /* keep last view */ }
    }

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    document.getElementById('closeRoutesPanel').addEventListener('click', () => setOpen(false));
    document.getElementById('routeBack').addEventListener('click', () => {
      stopDetailRefresh();
      currentRoute = null;
      clearRouteLayers();
      detailView.hidden = true;
      listView.hidden = false;
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    });
    chips.addEventListener('click', e => {
      const btn = e.target.closest('button[data-city]');
      if (!btn) return;
      city = btn.dataset.city;
      chips.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      search();
    });
    results.addEventListener('click', e => {
      const btn = e.target.closest('button[data-id]');
      if (btn) openRoute(btn.dataset.id);
    });
  }

  function setupRiderSearch() {
    const panel = document.getElementById('riderSearchPanel');
    const toggle = document.getElementById('riderSearchBtn');
    const status = document.getElementById('riderSearchStatus');
    const fields = ['riderFrom', 'riderTo'].map(id => ({
      input: document.getElementById(id),
      options: document.getElementById(`${id}Options`),
      selected: null,
      matches: [],
      timer: null,
      version: 0
    }));

    function setPanelOpen(open) {
      if (open) {
        document.getElementById('fleetDrawer').classList.remove('open');
        document.getElementById('busDetailDrawer').classList.remove('open');
        document.body.classList.remove('drawer-open');
        stopSelectedBusLivePoll();
        clearRouteLayers();
        selectedBus = null;
      }
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    }

    toggle.addEventListener('click', () => setPanelOpen(panel.hidden));
    document.getElementById('editRiderFilter').addEventListener('click', () => setPanelOpen(true));
    document.getElementById('closeRiderSearch').addEventListener('click', () => setPanelOpen(false));

    fields.forEach(field => {
      field.input.addEventListener('input', () => {
        field.selected = null;
        if (field.input.id === 'riderFrom') document.getElementById('riderStopInfo').textContent = '';
        field.options.hidden = true;
        clearTimeout(field.timer);
        const version = ++field.version;
        const query = field.input.value.trim();
        if (query.length < 2) return;
        field.timer = setTimeout(async () => {
          try {
            const res = await fetch(`/api/stops?search=${encodeURIComponent(query)}`);
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Stop search failed');
            if (version !== field.version) return;
            field.matches = data.stops;
            field.options.replaceChildren();
            data.stops.forEach(stop => {
              const option = document.createElement('option');
              option.value = stop.id;
              option.textContent = `${[stop.name, stop.mandal, stop.district].filter(Boolean).join(' - ')} (${stop.id})`;
              field.options.appendChild(option);
            });
            field.options.hidden = data.stops.length === 0;
            status.textContent = data.stops.length ? 'Select a matching stop (up to 30 shown).' : 'No matching stops found.';
          } catch (err) {
            if (version !== field.version) return;
            console.error('Stop search failed:', err);
            status.textContent = 'Could not load stops. Please try again.';
          }
        }, 250);
      });
      field.options.addEventListener('change', () => {
        field.selected = field.matches.find(stop => stop.id === field.options.value) || null;
        if (!field.selected) return;
        field.input.value = [field.selected.name, field.selected.mandal, field.selected.district].filter(Boolean).join(' - ');
        field.options.hidden = true;
        if (field.input.id === 'riderFrom') {
          document.getElementById('riderStopInfo').textContent = `Mapped location: ${field.selected.lat.toFixed(5)}, ${field.selected.lng.toFixed(5)}`;
        }
        status.textContent = '';
      });
    });

    document.getElementById('swapStopsBtn').addEventListener('click', () => {
      const [from, to] = fields;
      [from.selected, to.selected] = [to.selected, from.selected];
      [from.input.value, to.input.value] = [to.input.value, from.input.value];
      document.getElementById('riderStopInfo').textContent = from.selected
        ? `Mapped location: ${from.selected.lat.toFixed(5)}, ${from.selected.lng.toFixed(5)}`
        : '';
      fields.forEach(field => {
        clearTimeout(field.timer);
        field.version++;
        field.options.hidden = true;
      });
    });

    document.getElementById('clearRiderSearch').addEventListener('click', () => {
      riderRequestVersion++;
      riderFilter = null;
      document.getElementById('riderFilterSummary').hidden = true;
      document.getElementById('riderStopInfo').textContent = '';
      fields.forEach(field => {
        clearTimeout(field.timer);
        field.version++;
        field.selected = null;
        field.input.value = '';
        field.options.hidden = true;
      });
      if (riderStopMarker) {
        map.removeLayer(riderStopMarker);
        riderStopMarker = null;
      }
      status.textContent = 'Stop and trip filter cleared.';
      applyFilters();
    });

    function saveRecent(filter) {
      const item = {
        from: filter.from,
        to: filter.to || null
      };
      const key = JSON.stringify([item.from.id, item.to?.id || '']);
      const list = loadRecents().filter(r => JSON.stringify([r.from.id, r.to?.id || '']) !== key);
      list.unshift(item);
      try { localStorage.setItem('apsrtcRecentSearches', JSON.stringify(list.slice(0, 5))); } catch (e) { /* storage unavailable */ }
      renderRecents();
    }

    function loadRecents() {
      try {
        const list = JSON.parse(localStorage.getItem('apsrtcRecentSearches') || '[]');
        return Array.isArray(list) ? list.filter(r => r && r.from && r.from.id) : [];
      } catch (e) {
        return [];
      }
    }

    function renderRecents() {
      const box = document.getElementById('recentSearches');
      const list = loadRecents();
      box.replaceChildren();
      box.hidden = list.length === 0;
      list.forEach(r => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = r.to ? `${r.from.name} → ${r.to.name}` : r.from.name;
        btn.title = btn.textContent;
        btn.addEventListener('click', () => {
          const [from, to] = fields;
          from.selected = r.from;
          from.input.value = r.from.name;
          to.selected = r.to;
          to.input.value = r.to ? r.to.name : '';
          document.getElementById('riderStopInfo').textContent = '';
          fields.forEach(f => { f.options.hidden = true; });
          document.getElementById('riderSearchForm').requestSubmit();
        });
        box.appendChild(btn);
      });
    }

    renderRecents();
    saveRecentSearch = saveRecent;

    document.getElementById('nearMeBtn').addEventListener('click', () => {
      if (!navigator.geolocation) {
        status.textContent = 'Location is not available in this browser.';
        return;
      }
      status.textContent = 'Finding stops near you...';
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(`/api/stops/nearby?lat=${latitude}&lng=${longitude}`);
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || 'Nearby search failed');
          const from = fields[0];
          from.version++;
          from.selected = null;
          from.input.value = '';
          from.matches = data.stops;
          from.options.replaceChildren();
          data.stops.forEach(stop => {
            const option = document.createElement('option');
            option.value = stop.id;
            option.textContent = `${stop.name} - ${stop.distanceKm < 1 ? Math.round(stop.distanceKm * 1000) + ' m' : stop.distanceKm.toFixed(1) + ' km'}`;
            from.options.appendChild(option);
          });
          from.options.hidden = data.stops.length === 0;
          status.textContent = data.stops.length ? 'Select your nearest stop as the starting point.' : 'No mapped stops within 3 km.';
        } catch (err) {
          console.error('Nearby stops failed:', err);
          status.textContent = 'Could not find nearby stops.';
        }
      }, () => {
        status.textContent = 'Location permission denied or unavailable.';
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });

    document.getElementById('riderSearchForm').addEventListener('submit', async event => {
      event.preventDefault();
      const [from, to] = fields;
      if (!from.selected || (to.input.value.trim() && !to.selected)) {
        status.textContent = 'Please select a stop from each suggestion list.';
        return;
      }
      if (to.selected && from.selected.linkId === to.selected.linkId) {
        status.textContent = 'Choose two different stops.';
        return;
      }
      const filter = { from: from.selected, to: to.selected, busIds: new Set() };
      await updateRiderFilter(filter, true);
    });
  }

  updateRiderFilter = async function(filter, showResults = false) {
    const version = ++riderRequestVersion;
    const status = document.getElementById('riderSearchStatus');
    const params = filter.to
      ? new URLSearchParams({ from: filter.from.id, to: filter.to.id })
      : new URLSearchParams({ id: filter.from.id });
    const endpoint = filter.to ? '/api/buses/between' : '/api/stops/buses';
    status.textContent = 'Searching active trips...';
    try {
      const res = await fetch(`${endpoint}?${params}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Trip search failed');
      if (version !== riderRequestVersion) return;
      if (!showResults && !document.getElementById('riderSearchPanel').hidden) return;
      filter.busIds = new Set(data.buses.map(bus => bus.serviceDocId));
      riderFilter = filter;
      document.getElementById('riderFilterText').textContent = filter.to
        ? `${filter.from.name} → ${filter.to.name}. Active trips only; check stop status.`
        : `Trips serving ${filter.from.name}. Active trips only; check stop status.`;
      document.getElementById('riderFilterSummary').hidden = false;
      status.textContent = `${data.count} active trips match. Routes may have already passed these stops; check each bus for details.`;
      applyFilters();
      if (showResults) {
        saveRecentSearch(filter);
        if (riderStopMarker) map.removeLayer(riderStopMarker);
        const label = document.createElement('strong');
        label.textContent = [filter.from.name, filter.from.mandal, filter.from.district].filter(Boolean).join(' - ');
        riderStopMarker = L.marker([filter.from.lat, filter.from.lng]).addTo(map).bindPopup(label);
        if (window.innerWidth <= 768) {
          const point = map.project([filter.from.lat, filter.from.lng], 13);
          const offset = L.point(point.x, point.y + Math.round(map.getSize().y * 0.22));
          map.setView(map.unproject(offset, 13), 13);
        } else {
          map.setView([filter.from.lat, filter.from.lng], 13);
        }
        document.getElementById('riderSearchPanel').hidden = true;
        document.getElementById('riderSearchBtn').setAttribute('aria-expanded', 'false');
        document.getElementById('fleetDrawer').classList.add('open');
        document.getElementById('busDetailDrawer').classList.remove('open');
        stopSelectedBusLivePoll();
        clearRouteLayers();
        selectedBus = null;
        document.body.classList.add('drawer-open');
      }
    } catch (err) {
      if (version !== riderRequestVersion) return;
      console.error('Trip search failed:', err);
      status.textContent = 'Could not search trips. Please try again.';
      if (!showResults) {
        document.getElementById('riderFilterText').textContent = 'Could not refresh trip results. Edit or clear the filter.';
      }
    }
  };

  // Drawer & State controls
  const fleetDrawer = document.getElementById('fleetDrawer');
  const busDetailDrawer = document.getElementById('busDetailDrawer');

  function syncDrawerState() {
    const isAnyOpen = (fleetDrawer && fleetDrawer.classList.contains('open')) ||
                      (busDetailDrawer && busDetailDrawer.classList.contains('open'));
    const listBtn = document.getElementById('toggleListBtn');
    if (listBtn && fleetDrawer) listBtn.setAttribute('aria-expanded', String(fleetDrawer.classList.contains('open')));
    if (isAnyOpen) {
      document.body.classList.add('drawer-open');
    } else {
      document.body.classList.remove('drawer-open');
    }
  }

  function closeAllDrawers() {
    if (fleetDrawer) fleetDrawer.classList.remove('open');
    if (busDetailDrawer) {
      busDetailDrawer.classList.remove('open');
      clearRouteLayers();
      stopSelectedBusLivePoll();
      selectedBus = null;
    }
    syncDrawerState();
  }

  if (toggleListBtn) {
    toggleListBtn.addEventListener('click', () => {
      if (fleetDrawer) {
        fleetDrawer.classList.toggle('open');
        if (fleetDrawer.classList.contains('open')) {
          document.getElementById('riderSearchPanel').hidden = true;
          document.getElementById('riderSearchBtn').setAttribute('aria-expanded', 'false');
          if (busDetailDrawer) busDetailDrawer.classList.remove('open');
        }
      }
      syncDrawerState();
    });
  }

  if (closeFleetDrawer) {
    closeFleetDrawer.addEventListener('click', () => {
      if (fleetDrawer) fleetDrawer.classList.remove('open');
      syncDrawerState();
    });
  }

  if (closeDetailDrawer) {
    closeDetailDrawer.addEventListener('click', () => {
      closeAllDrawers();
    });
  }

  // Listen for hash changes (e.g. user navigating to #/trip_details?... or #/track?...)
  window.addEventListener('hashchange', () => {
    checkUrlParamsForTracking();
  });

  // Toggle map legend
  const toggleLegendBtn = document.getElementById('toggleLegendBtn');
  const mapLegend = document.getElementById('mapLegend');
  if (toggleLegendBtn && mapLegend) {
    toggleLegendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.matchMedia('(max-width: 768px)').matches) {
        mapLegend.classList.toggle('open-mobile');
      } else {
        mapLegend.classList.toggle('collapsed');
      }
    });

    // On mobile, tapping outside the open legend collapses it back
    document.addEventListener('click', (e) => {
      if (window.matchMedia('(max-width: 768px)').matches) {
        if (mapLegend.classList.contains('open-mobile') && !mapLegend.contains(e.target)) {
          mapLegend.classList.remove('open-mobile');
        }
      }
    });
  }

  // About / Info Modal controls
  const infoBtn = document.getElementById('infoBtn');
  const infoModalBackdrop = document.getElementById('infoModalBackdrop');
  const closeInfoModal = document.getElementById('closeInfoModal');
  const modalDismissBtn = document.getElementById('modalDismissBtn');

  function openInfoPopup() {
    if (!infoModalBackdrop) return;
    infoModalBackdrop.style.display = 'flex';
    // Force reflow for smooth transition
    void infoModalBackdrop.offsetWidth;
    infoModalBackdrop.classList.add('open');
    infoModalBackdrop.setAttribute('aria-hidden', 'false');
  }

  function closeInfoPopup() {
    if (!infoModalBackdrop) return;
    infoModalBackdrop.classList.remove('open');
    infoModalBackdrop.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (!infoModalBackdrop.classList.contains('open')) {
        infoModalBackdrop.style.display = 'none';
      }
    }, 220);
  }

  if (infoBtn) {
    infoBtn.addEventListener('click', openInfoPopup);
  }
  if (closeInfoModal) {
    closeInfoModal.addEventListener('click', closeInfoPopup);
  }
  if (modalDismissBtn) {
    modalDismissBtn.addEventListener('click', closeInfoPopup);
  }
  if (infoModalBackdrop) {
    infoModalBackdrop.addEventListener('click', (e) => {
      if (e.target === infoModalBackdrop) {
        closeInfoPopup();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && infoModalBackdrop && infoModalBackdrop.classList.contains('open')) {
      closeInfoPopup();
    }
  });
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
  if (statusText && !silent) statusText.innerText = 'Syncing live fleet...';

  try {
    const res = await fetch('/api/buses/live');
    const data = await res.json();

    if (data.success && Array.isArray(data.buses)) {
      allBuses = data.buses;
      if (data.filters) knownFilters = data.filters;
      const liveGpsCount = allBuses.filter(b => b.isLiveGps).length;
      if (statusText) statusText.innerText = `${allBuses.length} Buses (${liveGpsCount} Live GPS Fixes)`;
      const statTotalBuses = document.getElementById('statTotalBuses');
      if (statTotalBuses) statTotalBuses.innerText = allBuses.length;

      const drawerBuses = document.getElementById('drawerStatBuses');
      if (drawerBuses) drawerBuses.innerText = allBuses.length;

      populateFilterDropdowns();
      applyFilters();
      if (riderFilter && document.getElementById('riderSearchPanel').hidden) updateRiderFilter(riderFilter);
    }
  } catch (err) {
    console.error('Failed to fetch buses:', err);
    if (statusText) statusText.innerText = 'Sync failed. Retrying...';
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/buses/stats');
    const data = await res.json();
    if (data.success && data.stats) {
      const s = data.stats;
      const statDepots = document.getElementById('statDepots');
      if (statDepots) statDepots.innerText = s.depotsCount || '-';
      const statRoutes = document.getElementById('statRoutes');
      if (statRoutes) statRoutes.innerText = s.routesCount || '-';

      const drawerDepots = document.getElementById('drawerStatDepots');
      if (drawerDepots) drawerDepots.innerText = s.depotsCount || '-';
      const drawerRoutes = document.getElementById('drawerStatRoutes');
      if (drawerRoutes) drawerRoutes.innerText = s.routesCount || '-';
      const drawerBuses = document.getElementById('drawerStatBuses');
      if (drawerBuses && s.totalActive) drawerBuses.innerText = s.totalActive;

      if (s.lastSync) {
        const d = new Date(s.lastSync);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const statLastSync = document.getElementById('statLastSync');
        if (statLastSync) statLastSync.innerText = timeStr;
        const drawerSync = document.getElementById('drawerStatSync');
        if (drawerSync) drawerSync.innerText = timeStr;
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

  const depots = new Set(knownFilters.depots);
  const types = new Set(knownFilters.serviceTypes);

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
    if (riderFilter && !riderFilter.busIds.has(b.serviceDocId)) return false;
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
  if (drawer) drawer.classList.add('open');

  // Close fleet drawer on mobile if open so drawers don't stack
  const fleetDrawer = document.getElementById('fleetDrawer');
  if (window.innerWidth <= 768 && fleetDrawer) {
    fleetDrawer.classList.remove('open');
  }

  // Update body drawer-open class for responsive layout adjustments
  document.body.classList.add('drawer-open');

  if (flyTo && bus.lat && bus.lng) {
    if (window.innerWidth <= 768) {
      // In mobile half-sheet view, offset the center so the bus marker is placed in the top visible half of the map
      const mapHeight = map.getSize ? map.getSize().y : window.innerHeight;
      const targetPoint = map.project([bus.lat, bus.lng], 14);
      const offsetPoint = L.point(targetPoint.x, targetPoint.y + Math.round(mapHeight * 0.22));
      const targetLatLng = map.unproject(offsetPoint, 14);
      map.flyTo(targetLatLng, 14, { duration: 1.0 });
    } else {
      map.flyTo([bus.lat, bus.lng], 14, { duration: 1.2 });
    }
  }

  updateBusDetailDrawerUI(bus);
  startSelectedBusLivePoll(bus.serviceDocId);
  if (typeof window.traceFullRoute === 'function' && bus.serviceDocId) {
    Promise.resolve(window.traceFullRoute(bus.serviceDocId)).catch(() => {});
  }
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
        <div class="detail-card-val">${bus.driverMobile ? `<a href="tel:${bus.driverMobile}" style="color:#f87171;text-decoration:none;font-weight:600;">${bus.driverMobile}</a>` : 'Not Available'}</div>
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

    // Draw route polyline with bright red theme line
    routePolylineLayer = L.polyline(polyline, {
      color: '#ef4444',
      weight: 5,
      opacity: 0.9,
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

    // Fit map bounds to show full route (offset for mobile half-screen bottom sheet)
    if (window.innerWidth <= 768) {
      const mapHeight = map.getSize ? map.getSize().y : window.innerHeight;
      map.fitBounds(routePolylineLayer.getBounds(), {
        paddingTopLeft: [20, 20],
        paddingBottomRight: [20, Math.round(mapHeight * 0.52)]
      });
    } else {
      map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });
    }

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