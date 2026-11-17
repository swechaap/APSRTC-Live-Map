# 🚌 APSRTC Live Bus Fleet Tracker

A real-time, interactive live bus tracking platform that reverse-engineers and maps the entire active fleet of the **Andhra Pradesh State Road Transport Corporation (APSRTC)** from [apsrtclivetrack.com](https://apsrtclivetrack.com).

![APSRTC Live Bus Tracker](https://img.shields.io/badge/APSRTC-Live%20Tracking-06b6d4?style=for-the-badge&logo=google-maps)
![Node.js](https://img.shields.io/badge/Node.js-20+-green?style=for-the-badge&logo=node.js)
![Leaflet](https://img.shields.io/badge/Leaflet.js-Interactive%20Maps-10b981?style=for-the-badge&logo=leaflet)

---

## 🌟 Key Highlights

- **450+ to 500+ Active Buses Tracked Live**: Direct real-time stream of all buses running across 98+ depots in Andhra Pradesh (Vijayawada, Tirupati, Visakhapatnam, Guntur, Kurnool, Kakinada, Nellore, Kadapa, Anantapur, etc.).
- **Zero External npm Dependencies**: Built with native Node.js (`http`, `crypto`, `zlib`, `https`), meaning **zero `npm install` friction**—runs immediately out of the box.
- **12,500+ Mapped Bus Stops**: Pre-indexed GPS coordinate catalog of every official APSRTC boarding point and bus stop in the state.
- **Interactive Full-Screen Web Dashboard**:
  - Marker clustering for ultra-smooth 60 FPS rendering.
  - Color-coded by service type (Express, City Ordinary, Super Luxury, Pallevelugu, Garuda, Indra, Amaravathi, Electric buses).
  - Search by Bus Number, OPRS Service Number, Route Name, Depot, or Stop.
  - Filter by Depot and Service Type.
  - Auto-refresh countdown with live polling every 25 seconds.
  - **Trace Route & Waypoints**: Click any bus to view its real-time route polyline, departed stops, ETAs, and driver contact info.
- **Command-Line Interface (CLI)**: Inspect fleet stats, list active buses, trace specific bus routes, or export live coordinates to standard **GeoJSON**.

---

## 🚀 Quick Start

### 1. Launch the Live Web Map Dashboard

Navigate to the project directory and start the server:

```bash
cd /apsrtc-live-map
npm start
```

Then open your browser at:
👉 **[http://localhost:3000](http://localhost:3000)**

### 2. Using the CLI Tool

The project includes a command-line utility for quick inspections and GIS exports:

```bash
# View live fleet network statistics (active buses, depots, routes, service types)
node cli.js --stats

# List currently running buses in a formatted table
node cli.js --list

# Inspect a specific bus, its live location, and complete waypoint timeline
node cli.js --bus AP39UZ5449

# Export all active buses with their GPS coordinates to GeoJSON
node cli.js --export live_fleet.geojson
```

---

## 🛠️ How It Works (APSRTC Reverse-Engineering)

This project reverse-engineers the Flutter Web application powering `apsrtclivetrack.com`:

1. **Active Fleet Ingestion**: Queries the APSRTC production Google Cloud Firestore database (`apsrtc-uts-prod`), specifically the `serviceDetails` collection filtered for `journeyDate == <today>` and `tripStatus == '1'` (running trips).
2. **Stop Coordinate Resolution**: Integrates with the APSRTC UTS API endpoint `/mappedplaces/fetchAllUniquePlaces` with pre-shared auth headers (`Authorization: Bearer abhibus`, `x-api-key: 5369...`, `userId: 1363789069449`) to map `currentBoardingPoint` IDs to exact latitude and longitude.
3. **Secure Waypoint Decryption**: Implements the proprietary AES-256-GCM + Raw Deflate query encoder using the client key (`your APSRTC client key`) to query `/servicewaypointdetails/bydocid?q=<token>` for detailed stop-by-stop live arrival/departure history and ETAs.

---

## 📁 Project Structure

```
apsrtc-live-bus-tracker/
├── package.json               # Project manifest and scripts
├── cli.js                     # CLI utility for inspections and GeoJSON export
├── cache/
│   └── places.json            # Cached 12,500+ stop GPS catalog (auto-generated)
├── src/
│   ├── server.js              # Native HTTP server & REST API
│   └── services/
│       ├── apsrtcApi.js       # APSRTC API client, Firestore queries, and AES-256-GCM encoder
│       └── busTracker.js      # Fleet coordinator, GPS mapper, and GeoJSON generator
└── public/
    ├── index.html             # Dashboard UI
    ├── style.css              # Custom styling, dark mode, animations
    └── app.js                 # Leaflet map engine, clustering, route polylines
```

---

## 🌐 REST API Reference

- `GET /api/buses/live` — Returns all active buses currently running across AP.
  - Query parameters: `?depot=<name>`, `?type=<serviceType>`, `?search=<text>`
- `GET /api/buses/stats` — Summary of active fleet count, depots, routes, and last sync timestamp.
- `GET /api/buses/route?docId=<serviceDocId>` — Full route polyline and stop-by-stop departure/ETA status for a bus.
- `GET /api/buses/geojson` — Standard GeoJSON `FeatureCollection` for QGIS, Mapbox, or ArcGIS.
- `POST /api/buses/refresh` — Triggers an immediate cache refresh.

