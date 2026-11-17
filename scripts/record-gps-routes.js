#!/usr/bin/env node

/**
 * APSRTC Continuous Live GPS Route Recorder for OpenStreetMap (OSM)
 *
 * Runs continuously for hours, polling real-time GPS coordinates of moving buses
 * and saving continuous GPX / GeoJSON road traces with accurate speed, bearing,
 * and timestamps for tracing public transport route relations in JOSM / OSM.
 *
 * Usage:
 *   # Record a single bus:
 *   node scripts/record-gps-routes.js --bus 03112026_KV11_4_SIMHACHALAM
 *   node scripts/record-gps-routes.js --bus AP07Z0427
 *
 *   # Record all buses from a specific depot:
 *   node scripts/record-gps-routes.js --depot SIMHACHALAM
 *   node scripts/record-gps-routes.js --depot SRUNGAVARAPUKOTA
 *
 *   # Record all buses of a specific service type:
 *   node scripts/record-gps-routes.js --type "CITY ORDINARY"
 *   node scripts/record-gps-routes.js --type "METRO EXPRESS"
 *
 *   # Record all active buses across the state (or top N):
 *   node scripts/record-gps-routes.js --all --limit 30
 *
 * Options:
 *   --interval <seconds>  GPS polling frequency (default: 15 seconds)
 *   --out <directory>     Save folder (default: ./history/gps_traces)
 *   --min-dist <meters>   Distance threshold to skip stationary points (default: 4m)
 */

const path = require('path');
const busTracker = require('../src/services/busTracker');
const { searchBusTracking } = require('../src/services/apsrtcApi');
const { GpsRouteRecorder } = require('../src/services/gpsRecorder');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    bus: null,
    depot: null,
    type: null,
    all: false,
    interval: 15, // seconds
    outDir: path.join(process.cwd(), 'history', 'gps_traces'),
    minDist: 4, // meters
    limit: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      options.help = true;
    } else if (a === '--bus' || a === '-b') {
      options.bus = args[++i];
    } else if (a === '--depot' || a === '-d') {
      options.depot = args[++i];
    } else if (a === '--type' || a === '-t') {
      options.type = args[++i];
    } else if (a === '--all' || a === '-a') {
      options.all = true;
    } else if (a === '--interval' || a === '-i') {
      options.interval = parseInt(args[++i], 10) || 15;
    } else if (a === '--out' || a === '-o') {
      options.outDir = path.resolve(process.cwd(), args[++i]);
    } else if (a === '--min-dist') {
      options.minDist = parseFloat(args[++i]) || 4;
    } else if (a === '--limit' || a === '-l') {
      options.limit = parseInt(args[++i], 10);
    } else if (!options.bus && !a.startsWith('-')) {
      options.bus = a;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
=================================================================================
      APSRTC Continuous Live GPS Route Recorder for OpenStreetMap (OSM)
=================================================================================

Description:
  Records live, moving GPS breadcrumbs (<trkpt>) directly from APSRTC vehicle
  transponders every 15 seconds. Designed to run in the background for hours to
  capture actual driven highway paths for OpenStreetMap route relation mapping.

Commands & Examples:
  # 1. Record a specific bus by docId or vehicle number:
  node scripts/record-gps-routes.js --bus 03112026_KV11_4_SIMHACHALAM
  node scripts/record-gps-routes.js --bus AP07Z0427

  # 2. Record all buses running from a depot:
  node scripts/record-gps-routes.js --depot SIMHACHALAM
  node scripts/record-gps-routes.js --depot SRUNGAVARAPUKOTA

  # 3. Record all buses of a service category:
  node scripts/record-gps-routes.js --type "CITY ORDINARY"
  node scripts/record-gps-routes.js --type "METRO EXPRESS"

  # 4. Record top 25 buses across the entire state:
  node scripts/record-gps-routes.js --all --limit 25

Options:
  --interval <seconds>    Polling frequency (default: 15s)
  --out <directory>       Output directory (default: ./history/gps_traces)
  --min-dist <meters>     Distance filter to ignore stationary points (default: 4m)
  --limit <number>        Max buses to record simultaneously
  --help, -h              Show this help message

File Outputs (.gpx, .geojson, .json):
  Named automatically by: <SERVICE_TYPE>_<ROUTE>_<ORIGIN>_to_<DESTINATION>_<DOC_ID>
  Directly compatible with JOSM, QGIS, OsmAnd, and OSM trace upload.

Press Ctrl+C at any time to safely stop recording and finalize all files.
=================================================================================
`);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    return;
  }

  const recorder = new GpsRouteRecorder({
    intervalSeconds: options.interval,
    outDir: options.outDir,
    minDistanceMeters: options.minDist
  });

  // Catch SIGINT (Ctrl+C) to safely flush all files to disk
  process.on('SIGINT', () => {
    console.log('\n\n[Recorder] Received interrupt (Ctrl+C). Finalizing and saving all GPS traces to disk...');
    recorder.stop();
    const summary = recorder.getStatusSummary();
    console.log(`✔ Successfully saved ${summary.trips.length} GPS traces to:`);
    console.log(`  ${summary.outDir}`);
    console.log(`Total live GPS points logged across all buses: ${summary.totalPointsLogged}`);
    console.log('\nTip for OSM: Drag the .gpx or .geojson files into JOSM to trace the road relations.');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    recorder.stop();
    process.exit(0);
  });

  // 1. Single Bus Target
  if (options.bus) {
    const target = options.bus.trim();
    let serviceDocId = target;
    let busHint = null;

    if (!target.includes('_') || target.length < 15) {
      console.log(`Searching for bus: '${target}'...`);
      const matched = await searchBusTracking(target);
      if (!matched || matched.length === 0) {
        console.error(`✖ No active trip found matching '${target}'.`);
        process.exit(1);
      }
      busHint = matched[0];
      serviceDocId = busHint.serviceDocId;
      console.log(`Found active trip: ${serviceDocId} (${busHint.busNo} - ${busHint.depotName})`);
    }

    console.log(`Initializing GPS trace recorder for trip: ${serviceDocId}...`);
    const record = await recorder.registerTrip(serviceDocId, busHint);
    console.log(`✔ Registered: [${record.details.busNo}] ${record.details.serviceType} | ${record.details.sourceName} -> ${record.details.destinationName}`);
    console.log(`  File will be saved as: ${record.baseFileName}.gpx`);
    console.log(`  Destination Folder:    ${recorder.outDir}`);
  }
  // 2. Depot Target
  else if (options.depot) {
    const dUpper = options.depot.trim().toUpperCase();
    console.log(`Connecting to APSRTC Engine to discover buses in depot: ${dUpper}...`);
    await busTracker.init();
    const depotBuses = await busTracker.fetchBusesByDepot(dUpper);

    if (depotBuses.length === 0) {
      console.error(`✖ No active buses found for depot '${dUpper}'.`);
      process.exit(1);
    }

    const limit = options.limit || depotBuses.length;
    const targetBuses = depotBuses.slice(0, limit);
    console.log(`Registering ${targetBuses.length} active buses from ${dUpper} depot...`);

    for (const b of targetBuses) {
      await recorder.registerTrip(b.serviceDocId, b);
      console.log(`  + Registered: [${b.busNo}] ${b.sourceName} -> ${b.destinationName} (${b.oprsNo || b.serviceType})`);
    }
  }
  // 3. Service Type Target
  else if (options.type) {
    const tUpper = options.type.trim().toUpperCase();
    console.log(`Connecting to APSRTC Engine to discover buses of type: ${tUpper}...`);
    await busTracker.init();
    const all = busTracker.getActiveBuses();
    const matched = all.filter(b => b.serviceType && b.serviceType.toUpperCase().includes(tUpper));

    if (matched.length === 0) {
      console.error(`✖ No active buses found for type '${tUpper}'.`);
      process.exit(1);
    }

    const limit = options.limit || 30;
    const targetBuses = matched.slice(0, limit);
    console.log(`Registering ${targetBuses.length} buses of type '${tUpper}'...`);

    for (const b of targetBuses) {
      await recorder.registerTrip(b.serviceDocId, b);
      console.log(`  + Registered: [${b.busNo}] ${b.sourceName} -> ${b.destinationName} (${b.depotName})`);
    }
  }
  // 4. All Buses
  else if (options.all) {
    console.log('Connecting to APSRTC Engine to discover active fleet...');
    await busTracker.init();
    const all = busTracker.getActiveBuses();
    const limit = options.limit || 20;
    const targetBuses = all.filter(b => b.sourceName && b.destinationName).slice(0, limit);

    console.log(`Registering ${targetBuses.length} active buses across Andhra Pradesh...`);
    for (const b of targetBuses) {
      await recorder.registerTrip(b.serviceDocId, b);
      console.log(`  + Registered: [${b.busNo}] ${b.serviceType} | ${b.sourceName} -> ${b.destinationName}`);
    }
  } else {
    printHelp();
    return;
  }

  console.log('\n=================================================================================');
  console.log(`  APSRTC LIVE GPS FLIGHT RECORDER ACTIVE (${recorder.activeRecords.size} buses monitored)`);
  console.log(`  Interval: ${recorder.intervalSeconds}s | Saving to: ${recorder.outDir}`);
  console.log('  Leave this script running. Press Ctrl+C at any time to finish and save.');
  console.log('=================================================================================\n');

  // Start continuous recording loop with tick callback
  recorder.start((summary) => {
    const timeStr = new Date().toLocaleTimeString();
    console.log(`\n[${timeStr}] Heartbeat: ${summary.activeBuses} buses monitored | ${summary.totalPointsLogged} total GPS points logged | Files updated`);

    for (const t of summary.trips) {
      console.log(`  - [${t.busNo.padEnd(10)}] ${t.route.padEnd(36)} | Pts: ${String(t.pointsCount).padStart(3, ' ')} | Dist: ${t.distanceKm.padStart(5, ' ')} km | Speed: ${t.currentSpeed.padEnd(10)} | GPS: ${t.currentCoords}`);
    }
  });
}

main().catch(err => {
  console.error('Recorder Fatal Error:', err);
  process.exit(1);
});

