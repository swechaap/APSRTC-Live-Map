#!/usr/bin/env node

/**
 * APSRTC Route & GPS Trace History Exporter for OpenStreetMap (OSM)
 *
 * Exports bus routes with stop sequences, coordinates, scheduled times,
 * and polyline tracks into standard GeoJSON and GPX formats with pre-configured
 * OSM Public Transport v2 relation tags.
 *
 * Usage:
 *   node scripts/export-routes.js --bus 03112026_KV11_4_SIMHACHALAM
 *   node scripts/export-routes.js --bus AP07Z0427
 *   node scripts/export-routes.js --depot SIMHACHALAM
 *   node scripts/export-routes.js --type "CITY ORDINARY"
 *   node scripts/export-routes.js --all [--limit 50]
 *   node scripts/export-routes.js --format gpx --out ./osm_tracks
 */

const path = require('path');
const busTracker = require('../src/services/busTracker');
const { fetchActiveTrips, fetchServiceDetails, fetchServiceWaypointDetails } = require('../src/services/apsrtcApi');
const { exportRoute, exportMultipleRoutes } = require('../src/services/routeExporter');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    bus: null,
    depot: null,
    type: null,
    all: false,
    format: 'all',
    outDir: path.join(process.cwd(), 'history', 'routes'),
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
    } else if (a === '--format' || a === '-f') {
      options.format = args[++i];
    } else if (a === '--out' || a === '-o') {
      options.outDir = path.resolve(process.cwd(), args[++i]);
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
========================================================================
   APSRTC Route & GPS Trace History Exporter for OpenStreetMap (OSM)
========================================================================

Commands & Examples:
  # Export a single bus by serviceDocId or registration number:
  node scripts/export-routes.js --bus 03112026_KV11_4_SIMHACHALAM
  node scripts/export-routes.js --bus AP07Z0427

  # Export all routes from a specific depot:
  node scripts/export-routes.js --depot SIMHACHALAM
  node scripts/export-routes.js --depot SRUNGAVARAPUKOTA

  # Export all routes of a specific service category:
  node scripts/export-routes.js --type "CITY ORDINARY"
  node scripts/export-routes.js --type "METRO EXPRESS"

  # Export all unique routes currently active across the state:
  node scripts/export-routes.js --all --limit 50

Options:
  --format <all|geojson|gpx|json>   File format to generate (default: all)
  --out <directory>                 Destination folder (default: ./history/routes)
  --limit <number>                  Maximum routes to export in bulk mode
  --help, -h                        Show this reference manual

Output Files:
  1. .geojson  -> FeatureCollection with complete OSM relation tags and bus stop nodes
  2. .gpx      -> Standard GPS Exchange file (drag & drop directly into JOSM / QGIS)
  3. .json     -> Complete raw schedule & driver metadata archive

OSM Relation Tags Included:
  type=route, route=bus, name, ref, from, to, operator=APSRTC, network=APSRTC,
  colour, public_transport:version=2
========================================================================
`);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    return;
  }

  // 1. Fast-path: Export single bus/service
  if (options.bus) {
    const { searchBusTracking } = require('../src/services/apsrtcApi');
    let targetDocId = options.bus.trim();

    if (!targetDocId.includes('_') || targetDocId.length < 15) {
      console.log(`\nSearching for bus: '${targetDocId}'...`);
      const matched = await searchBusTracking(targetDocId);
      if (!matched || matched.length === 0) {
        console.error(`✖ No active trip found matching '${targetDocId}'.`);
        process.exit(1);
      }
      targetDocId = matched[0].serviceDocId;
      console.log(`Found active trip: ${targetDocId}`);
    }

    console.log(`\nFetching stop-by-stop waypoints and generating OSM trace files for: ${targetDocId}...`);

    try {
      const res = await exportRoute(targetDocId, {
        outDir: options.outDir,
        format: options.format
      });

      console.log('\n✔ Route Successfully Exported for OpenStreetMap!');
      console.log(`  Base Name:    ${res.baseFileName}`);
      console.log(`  Stops Count:  ${res.stopsCount} stops`);
      console.log(`  Directory:    ${res.outDir}`);
      console.log('\nGenerated Files:');
      for (const f of res.files) {
        console.log(`  - ${path.basename(f)}`);
      }
      console.log('\nTip for OSM Mappers: Drag the .gpx or .geojson file into JOSM / QGIS to trace the route relation.');
    } catch (err) {
      console.error(`✖ Failed to export route: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log('Connecting to APSRTC Fleet Engine...');
  await busTracker.init();

  // 2. Export by Depot
  if (options.depot) {
    const dUpper = options.depot.trim().toUpperCase();
    console.log(`\nQuerying all active routes for depot: ${dUpper}...`);
    const depotBuses = await busTracker.fetchBusesByDepot(dUpper);

    if (depotBuses.length === 0) {
      console.log(`No active buses found for depot '${dUpper}'.`);
      return;
    }

    // Deduplicate by route/direction
    const seen = new Set();
    const docIds = [];
    for (const b of depotBuses) {
      const key = `${b.sourceName}_to_${b.destinationName}_${b.oprsNo || b.routeName}`;
      if (!seen.has(key)) {
        seen.add(key);
        docIds.push(b.serviceDocId);
      }
    }

    const targetIds = options.limit ? docIds.slice(0, options.limit) : docIds;
    console.log(`Found ${depotBuses.length} buses (${targetIds.length} distinct routes). Starting export...`);
    await exportMultipleRoutes(targetIds, { outDir: options.outDir, format: options.format });
    return;
  }

  // 3. Export by Service Type
  if (options.type) {
    const tUpper = options.type.trim().toUpperCase();
    console.log(`\nQuerying all active routes for service type: ${tUpper}...`);
    const all = busTracker.getActiveBuses();
    const matched = all.filter(b => b.serviceType && b.serviceType.toUpperCase().includes(tUpper));

    if (matched.length === 0) {
      console.log(`No active buses found for type '${tUpper}'.`);
      return;
    }

    // Deduplicate
    const seen = new Set();
    const docIds = [];
    for (const b of matched) {
      const key = `${b.sourceName}_to_${b.destinationName}_${b.oprsNo || b.routeName}`;
      if (!seen.has(key)) {
        seen.add(key);
        docIds.push(b.serviceDocId);
      }
    }

    const targetIds = options.limit ? docIds.slice(0, options.limit) : docIds;
    console.log(`Found ${matched.length} buses (${targetIds.length} distinct routes). Starting export...`);
    await exportMultipleRoutes(targetIds, { outDir: options.outDir, format: options.format });
    return;
  }

  // 4. Export all unique routes across the state
  if (options.all) {
    console.log('\nCollecting all distinct active routes across Andhra Pradesh...');
    const all = busTracker.getActiveBuses();

    const seen = new Set();
    const docIds = [];
    for (const b of all) {
      if (!b.sourceName || !b.destinationName) continue;
      const key = `${b.serviceType}_${b.sourceName}_to_${b.destinationName}_${b.routeName || b.oprsNo}`;
      if (!seen.has(key)) {
        seen.add(key);
        docIds.push(b.serviceDocId);
      }
    }

    const limit = options.limit || 50;
    const targetIds = docIds.slice(0, limit);
    console.log(`Identified ${seen.size} unique routes in the active fleet.`);
    console.log(`Exporting ${targetIds.length} routes (use --limit <N> to adjust)...`);

    await exportMultipleRoutes(targetIds, { outDir: options.outDir, format: options.format });
    return;
  }

  // No command specified: show help
  printHelp();
}

main().catch(err => {
  console.error('Export Error:', err);
  process.exit(1);
});
