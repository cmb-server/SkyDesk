#!/usr/bin/env node
// Slims raw Natural Earth / US-states GeoJSON into compact bundles for the
// Flight Tracker map: keeps only a name property and rounds coordinates to a
// fixed precision (~1 km), which dramatically reduces file size.
//
// Usage: download the raw files first, then run this to overwrite the bundles:
//   curl -sL -o src/data/world-countries.geo.json \
//     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
//   curl -sL -o src/data/us-states.geo.json \
//     https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json
//   node src/scripts/gen-geojson.js
//
// The water bundle (oceans + lakes for the radar's blue water fill) is fetched
// directly from the Natural Earth vector CDN — no manual download needed:
//   node src/scripts/gen-geojson.js          (slims local files + fetches water)

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PRECISION = 2; // decimal places (~1.1 km)

// Natural Earth water sources for the radar's blue fill. The global 10m ocean
// polygon is ~8 MB even after slimming, so the ocean coastline comes from the
// lighter 50m tier (still far finer than the 110m country outlines), while
// lakes use the detailed 10m tier so the Great Lakes read crisply near DTW.
const NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const WATER_SOURCES = [
  { url: `${NE_BASE}/ne_50m_ocean.geojson`, kind: "ocean", minArea: 0.002 },
  { url: `${NE_BASE}/ne_10m_lakes.geojson`, kind: "lake", minArea: 0.01 },
];

function round(n) {
  return Number(n.toFixed(PRECISION));
}

function roundCoords(coords) {
  if (typeof coords[0] === "number") return [round(coords[0]), round(coords[1])];
  return coords.map(roundCoords);
}

// Collapse consecutive duplicate points produced by rounding (ring-aware).
function dedupeRing(ring) {
  const out = [];
  for (const pt of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
  }
  return out.length >= 4 ? out : ring; // keep a valid closed ring
}

function cleanGeometry(geom) {
  if (!geom) return null;
  const c = roundCoords(geom.coordinates);
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: c.map(dedupeRing) };
  }
  if (geom.type === "MultiPolygon") {
    return { type: "MultiPolygon", coordinates: c.map((poly) => poly.map(dedupeRing)) };
  }
  return { type: geom.type, coordinates: c };
}

function slim(inFile, nameKeys) {
  const full = path.join(DATA_DIR, inFile);
  const data = JSON.parse(fs.readFileSync(full, "utf8"));
  const features = data.features.map((f) => {
    const props = f.properties || {};
    let name = "";
    for (const k of nameKeys) {
      if (props[k]) {
        name = props[k];
        break;
      }
    }
    return { type: "Feature", properties: { name }, geometry: cleanGeometry(f.geometry) };
  });
  const out = { type: "FeatureCollection", features };
  fs.writeFileSync(full, JSON.stringify(out));
  const kb = (fs.statSync(full).size / 1024).toFixed(0);
  console.log(`${inFile}: ${features.length} features, ${kb} KB`);
}

// --- Water (ocean + lakes) -------------------------------------------------

// Bounding box of a ring, used to drop polygons too small to matter at the
// radar's ranges (keeps the bundle small without losing big lakes/coastlines).
function ringBBoxArea(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

// Radial-distance simplification: drop points within `tol` degrees of the last
// kept point. At the radar's ranges (≥ ~9 km radius) a ~3 km tolerance is
// invisible but roughly halves the coastline vertex count / file size.
const SIMPLIFY_TOL = 0.03;

function simplifyRing(ring) {
  if (ring.length <= 4) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const last = out[out.length - 1];
    const dx = ring[i][0] - last[0];
    const dy = ring[i][1] - last[1];
    if (dx * dx + dy * dy >= SIMPLIFY_TOL * SIMPLIFY_TOL) out.push(ring[i]);
  }
  out.push(ring[ring.length - 1]); // keep the closing point
  return out.length >= 4 ? out : ring;
}

function slimWaterGeometry(geom, minArea) {
  if (!geom) return null;
  const polys =
    geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.type === "MultiPolygon"
      ? geom.coordinates
      : [];
  const kept = [];
  for (const poly of polys) {
    const rings = poly.map((ring) => simplifyRing(dedupeRing(roundCoords(ring))));
    // Outer ring (index 0) decides whether the polygon survives the size filter.
    if (!rings[0] || rings[0].length < 4) continue;
    if (ringBBoxArea(rings[0]) < minArea) continue;
    kept.push(rings);
  }
  if (!kept.length) return null;
  return { type: "MultiPolygon", coordinates: kept };
}

async function fetchJson(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function genWater() {
  const features = [];
  for (const { url, kind, minArea } of WATER_SOURCES) {
    const data = await fetchJson(url);
    let count = 0;
    for (const f of data.features || []) {
      const geom = slimWaterGeometry(f.geometry, minArea);
      if (!geom) continue;
      features.push({ type: "Feature", properties: { kind }, geometry: geom });
      count++;
    }
    console.log(`  ${kind}: ${count} features kept`);
  }
  const out = { type: "FeatureCollection", features };
  const full = path.join(DATA_DIR, "water.geo.json");
  fs.writeFileSync(full, JSON.stringify(out));
  const kb = (fs.statSync(full).size / 1024).toFixed(0);
  console.log(`water.geo.json: ${features.length} features, ${kb} KB`);
}

slim("world-countries.geo.json", ["NAME", "ADMIN", "name"]);
slim("us-states.geo.json", ["name", "NAME"]);

genWater().catch((e) => {
  console.error(`water fetch failed: ${e.message}`);
  process.exitCode = 1;
});
