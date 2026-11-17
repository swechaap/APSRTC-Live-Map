#!/usr/bin/env node

/**
 * APSRTC Live Bus Tracker CLI Utility
 * Usage:
 *   node cli.js --list                    # List all currently active buses
 *   node cli.js --bus <BUS_NUMBER>        # Inspect specific bus & waypoint route
 *   node cli.js --stats                   # Show current network statistics
 *   node cli.js --export [file]           # Export live buses snapshot to GeoJSON
 *   node cli.js --export-route <BUS_OR_ID># Export scheduled stops route (GeoJSON + GPX)
 *   node cli.js --record <BUS_OR_ID>      # Live flight record moving GPS breadcrumbs for hours
 */

const fs = require('fs');
const path = require('path');
const busTracker = require('./src/services/busTracker');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--list';

  // Fast-path: Export single route for OpenStreetMap without full fleet sync
  if (command === '--export-route' || command === '--export-osm') {
    const query = args[1];
    if (!query) {
      console.error('Please specify a bus number or serviceDocId: e.g. node cli.js --export-route 03112026_KV11_4_SIMHACHALAM');
      process.exit(1);
    }
    const { exportRoute } = require('./src/services/routeExporter');
    const { searchBusTracking } = require('./src/services/apsrtcApi');

    let targetDocId = query;
    if (!query.includes('_') || query.length < 15) {
      console.log(`Searching for bus: '${query}'...`);
      const matched = await searchBusTracking(query);
      if (!matched || matched.length === 0) {
        console.error(`✖ No active running bus found matching '${query}'.`);
        process.exit(1);
      }
      targetDocId = matched[0].serviceDocId;
    }

    console.log(`\nExporting OSM route trace for: ${targetDocId}...`);
    try {
      const res = await exportRoute(targetDocId);
      console.log('\n✔ Route Successfully Exported for OpenStreetMap:');
      console.log(`  Base Name:   ${res.baseFileName}`);
      console.log(`  Total Stops: ${res.stopsCount}`);
      console.log(`  Directory:   ${res.outDir}`);
      console.log('\nGenerated Files:');
      for (const f of res.files) {
        console.log(`  - ${f}`);
      }
      console.log('\nTip for OSM: Open the .gpx or .geojson file directly in JOSM / QGIS to build the route relation.');
    } catch (e) {
      console.error('Export failed:', e.message);
    }
    return;
  }

  // Live flight recorder: record GPS coordinates as buses move for hours
  if (command === '--record' || command === '--record-route') {
    const target = args[1];
    if (!target) {
      console.error('Please specify a bus number or serviceDocId: e.g. node cli.js --record 03112026_P172_3_WALTAIR');
      process.exit(1);
    }
    process.argv = [process.argv[0], path.join(__dirname, 'scripts', 'record-gps-routes.js'), '--bus', target];
    require('./scripts/record-gps-routes.js');
    return;
  }

  console.log('Connecting to APSRTC Live Tracking Engine...');
  await busTracker.init();

  const buses = busTracker.getActiveBuses();

  if (command === '--stats') {
    const stats = busTracker.getStats();
    console.log('\n================ APSRTC LIVE FLEET STATS ================');
    console.log(`Total Active Running Buses: ${stats.totalActive}`);
    console.log(`Active Depots:              ${stats.depotsCount}`);
    console.log(`Active Routes:              ${stats.routesCount}`);
    console.log(`Last Synced:                ${stats.lastSync}`);
    console.log('\nService Type Breakdown:');
    for (const [type, count] of Object.entries(stats.serviceTypes)) {
      console.log(`  - ${type.padEnd(20)}: ${count}`);
    }
    console.log('=========================================================\n');
    return;
  }

  if (command === '--export') {
    const filename = args[1] || 'apsrtc_live_buses.geojson';
    const filePath = path.resolve(process.cwd(), filename);
    const geojson = busTracker.toGeoJSON();
    fs.writeFileSync(filePath, JSON.stringify(geojson, null, 2));
    console.log(`\nSuccessfully exported ${geojson.features.length} live buses to:`);
    console.log(`  ${filePath}\n`);
    return;
  }


  if (command === '--bus') {
    const query = args[1];
    if (!query) {
      console.error('Please specify a bus number or service number: e.g. node cli.js --bus AP39UZ5449');
      process.exit(1);
    }

    const bus = await busTracker.findOrFetchBus(query);

    if (!bus) {
      console.log(`No active running bus found matching '${query}'.`);
      return;
    }

    console.log('\n================ BUS LIVE STATUS ================');
    console.log(`Bus Number:     ${bus.busNo}`);
    console.log(`Service / OPRS: ${bus.oprsNo}`);
    console.log(`Type:           ${bus.serviceType}`);
    console.log(`Route:          ${bus.sourceName} -> ${bus.destinationName} (${bus.routeName})`);
    console.log(`Depot:          ${bus.depotName}`);
    console.log(`Current Stop:   ${bus.currentStop} (${bus.district})`);
    console.log(`GPS Coords:     ${bus.lat}, ${bus.lng} ${bus.isLiveGps ? '🟢 LIVE GPS FIX' : '📍 Station Estimate'}`);
    if (bus.isLiveGps) {
      console.log(`Speed:          ${bus.speed.toFixed(1)} km/h`);
      console.log(`Heading/Bearing:${bus.bearing.toFixed(1)}°`);
    }
    console.log(`Driver:         ${bus.driverName} (${bus.driverMobile || 'N/A'})`);
    console.log(`Refreshed At:   ${bus.refreshedAt}`);
    console.log('=================================================\n');

    console.log('Fetching detailed waypoint timeline...');
    try {
      const route = await busTracker.getBusRouteDetails(bus.serviceDocId);
      console.log(`Found ${route.totalStops} stops along the route:\n`);
      for (const stop of route.stops) {
        const status = stop.hasDeparted ? '✔ PASSED' : '⏳ UPCOMING';
        const time = stop.vtsDepartureTime ? `Departed: ${stop.vtsDepartureTime}` : (stop.scheduleTime || '');
        console.log(`  [#${String(stop.seqNo).padStart(2, '0')}] ${stop.name.padEnd(28)} | ${status.padEnd(10)} | ${time}`);
      }
      console.log('');
    } catch (e) {
      console.error('Could not fetch route waypoints:', e.message);
    }
    return;
  }

  // Default: --list
  console.log(`\nFound ${buses.length} active buses currently running across Andhra Pradesh:\n`);
  console.log('BUS NO       OPRS NO      DEPOT             CURRENT STOP                   DESTINATION');
  console.log('-------------------------------------------------------------------------------------------------');

  for (const b of buses.slice(0, 30)) {
    const no = (b.busNo || '').padEnd(12);
    const oprs = (b.oprsNo || '').padEnd(12);
    const depot = (b.depotName || '').slice(0, 16).padEnd(17);
    const stop = (b.currentStop || '').slice(0, 28).padEnd(30);
    const dest = (b.destinationName || '').slice(0, 25);
    console.log(`${no} ${oprs} ${depot} ${stop} ${dest}`);
  }

  if (buses.length > 30) {
    console.log(`... and ${buses.length - 30} more buses running.`);
  }
  console.log('\nTo inspect a specific bus, run: node cli.js --bus <BUS_NUMBER>');
  console.log('To view all buses on a map, run: npm start');
}

main().catch(err => {
  console.error('CLI Error:', err);
  process.exit(1);
});

