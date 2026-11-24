const test = require('node:test');
const assert = require('node:assert/strict');
const tracker = require('../src/services/busTracker');

test('stop and journey search use ordered waypoints and linked stop IDs', () => {
  const originalPlaces = tracker.riderStopsById;
  const originalBuses = tracker.busesCache;
  const originalStops = tracker.tripStopsByBus;
  const a = { id: '1', linkId: '1', name: 'ALPHA', district: 'A', lat: 1, lng: 1 };
  const linked = { id: '4', linkId: '1', name: 'ALPHA LINK', district: 'A', lat: 1, lng: 1 };
  const b = { id: '2', linkId: '2', name: 'BETA', district: 'B', lat: 2, lng: 2 };
  const c = { id: '3', linkId: '3', name: 'GAMMA', district: 'C', lat: 3, lng: 3 };
  try {
    tracker.riderStopsById = new Map([['1', a], ['alias-1', a], ['4', linked], ['2', b], ['3', c]]);
    tracker.busesCache = [{ serviceDocId: 'forward' }, { serviceDocId: 'reverse' }, { serviceDocId: 'unknown' }];
    tracker.tripStopsByBus = new Map([
      ['forward', ['alias-1', '2', '3']],
      ['reverse', ['3', '2', '1']]
    ]);

    assert.deepEqual(tracker.searchStops(' alp '), [a, linked]);
    assert.deepEqual(tracker.getStopBuses('2').map(bus => bus.serviceDocId), ['forward', 'reverse']);
    assert.deepEqual(tracker.getBusesBetweenStops('1', '3').map(bus => bus.serviceDocId), ['forward']);
    assert.deepEqual(tracker.getBusesBetweenStops('4', '3').map(bus => bus.serviceDocId), ['forward']);
    assert.deepEqual(tracker.getBusesBetweenStops('3', '1').map(bus => bus.serviceDocId), ['reverse']);
    assert.equal(tracker.getBusesBetweenStops('1', 'alias-1'), null);
    assert.equal(tracker.getBusesBetweenStops('1', '4'), null);
    assert.equal(tracker.getStopBuses('missing'), null);
    assert.equal(tracker.getBusesBetweenStops('missing', '2'), null);
    assert.equal(tracker.nearbyStops(2.001, 2.001, 5, 1)[0].id, '2');
    assert.equal(tracker.nearbyStops(2.001, 2.001, 5, 1).length, 1);
  } finally {
    tracker.riderStopsById = originalPlaces;
    tracker.busesCache = originalBuses;
    tracker.tripStopsByBus = originalStops;
  }
});
