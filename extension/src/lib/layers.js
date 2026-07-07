// Map layers (weather radar + terrain) drawn under the radar blips.
//
// Tiles are slippy-map (XYZ) PNGs drawn onto the PPI radar with a simple
// equirectangular approximation around the radar center — exact enough at the
// small ranges the radar uses, and it keeps neighbouring tiles seamless.
//
// Weather comes from RainViewer (the latest radar frame path is resolved by the
// service worker and cached here). Terrain is Esri's World Hillshade relief.
// Tile images are loaded without crossOrigin (we only ever draw them, never
// read pixels back) so they render even where a CORS header is absent.
window.SKLayers = (() => {
  const DEG = Math.PI / 180;
  const cache = new Map(); // url -> HTMLImageElement (with __sk: loading|ok|err)
  const MAX_TILES = 80; // safety cap so a huge range can't spawn a tile storm
  const MAX_CACHE = 120; // LRU cap — long sessions won't accumulate hundreds of Image objects

  let weather = null; // { host, path, ts }
  let weatherPending = false;

  // Water polygons (ocean + lakes), flattened to { bbox, rings } for a fast
  // bbox prefilter. Lazy-loaded once from the bundled GeoJSON and cached.
  let waterPolys = null; // [{ bbox:[minLon,minLat,maxLon,maxLat], rings:[[ [lon,lat], ... ], ...] }]
  let waterPending = false;
  let waterFailed = false;

  function pruneTileCache() {
    for (const [url, img] of cache) {
      if (img.__sk === "err" || img.__sk === "bad") cache.delete(url);
    }
    while (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  // Esri hillshade placeholders are a constant ~2.5 KB grey JPEG; real relief
  // tiles are much larger (verified >5 KB at z13 on land). RainViewer z8+
  // placeholders are ~1.4 KB grey PNG — callers pass minBytes per layer.
  const TERRAIN_MIN_BYTES = 3200;

  function loadTileImage(url, onReady) {
    const img = new Image();
    img.__sk = "loading";
    img.onload = () => {
      img.__sk = "ok";
      if (typeof onReady === "function") onReady();
    };
    img.onerror = () => {
      img.__sk = "err";
      cache.delete(url);
    };
    img.src = url;
    cache.set(url, img);
    pruneTileCache();
  }

  function validateTileBytes(url, minBytes, onResult) {
    try {
      chrome.runtime.sendMessage({ type: "validate-map-tile", url, minBytes }, (res) => {
        void chrome.runtime?.lastError;
        onResult(res && res.ok && res.good);
      });
    } catch (_) {
      onResult(false);
    }
  }

  function getTile(url, onReady, opts) {
    const minBytes = opts && opts.minBytes;
    const hit = cache.get(url);
    if (hit) {
      if (hit.__sk === "ok") {
        cache.delete(url);
        cache.set(url, hit);
        return hit;
      }
      if (hit.__sk === "bad" || hit.__sk === "err") return null;
      return null;
    }
    if (minBytes) {
      const pending = { __sk: "loading" };
      cache.set(url, pending);
      validateTileBytes(url, minBytes, (good) => {
        if (!good) {
          pending.__sk = "bad";
          cache.delete(url);
          return;
        }
        loadTileImage(url, onReady);
      });
      return null;
    }
    loadTileImage(url, onReady);
    return null;
  }

  // Latest RainViewer radar frame. Resolved by the background worker (which has
  // the host permission for api.rainviewer.com) and cached for a few minutes.
  function ensureWeather(onReady) {
    if (weather && Date.now() - weather.ts < 4 * 60 * 1000) return weather;
    if (weatherPending) return weather;
    weatherPending = true;
    try {
      chrome.runtime.sendMessage({ type: "weather-frames" }, (res) => {
        void chrome.runtime?.lastError;
        weatherPending = false;
        if (res && res.ok && res.host && res.path) {
          weather = { host: res.host, path: res.path, ts: Date.now() };
          if (typeof onReady === "function") onReady();
        }
      });
    } catch (_) {
      weatherPending = false;
    }
    return weather;
  }

  const lon2tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2tileY = (lat, z) => {
    const r = lat * DEG;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  const tileX2lon = (x, z) => (x / 2 ** z) * 360 - 180;
  const tileY2lat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  function zoomFor(rangeNm, maxR, lat, maxZ) {
    const metersPerPixel = (rangeNm * 1852) / maxR;
    const z = Math.log2((156543.03392 * Math.cos(lat * DEG)) / metersPerPixel);
    return Math.max(2, Math.min(maxZ || 15, Math.round(z)));
  }

  // Ray-cast point-in-polygon (lon, lat) against one ring [[lon,lat], ...].
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInWater(lon, lat, polys) {
    if (!polys) return false;
    for (const poly of polys) {
      const b = poly.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      let inside = false;
      for (const ring of poly.rings) {
        if (pointInRing(lon, lat, ring)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  function tileCenterLonLat(x, y, z) {
    return {
      lon: (tileX2lon(x, z) + tileX2lon(x + 1, z)) / 2,
      lat: (tileY2lat(y, z) + tileY2lat(y + 1, z)) / 2,
    };
  }

  // Full-page background mode: slippy tiles project as a square bbox and a hard
  // scope clip leaves a visible grey disc/box on the page. Fade alpha to zero at
  // the outer range ring instead of cutting a hard edge.
  function applyBackgroundLayerFade(ctx, cx, cy, maxR) {
    // The mask must run at full strength. "destination-in" sets the existing
    // layer's resulting alpha to destAlpha * sourceAlpha, and sourceAlpha is
    // scaled by ctx.globalAlpha — which callers leave set to the layer's reduced
    // opacity (e.g. 0.21 for terrain). Without forcing it back to 1 the whole
    // layer's alpha gets multiplied a second time (0.21 -> ~0.044) and faint
    // layers like terrain vanish. Keep the soft outer fade, but at full alpha.
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    const fade = ctx.createRadialGradient(cx, cy, maxR * 0.5, cx, cy, maxR * 1.06);
    fade.addColorStop(0, "rgba(255,255,255,1)");
    fade.addColorStop(0.88, "rgba(255,255,255,0.45)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = fade;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * 1.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = prevAlpha;
  }

  function drawLayer(ctx, cx, cy, maxR, cfg, center, urlFn, opacity, onReady, maxZ, blend, layerOpts) {
    if (!center || center.lat == null || !(opacity > 0) || maxR <= 0) return;
    const background = cfg && cfg.mode === "background";
    const rangeNm = cfg.rangeNm || 40;
    const z = zoomFor(rangeNm, maxR, center.lat, maxZ);
    const nTiles = 2 ** z; // valid tile index range is [0, nTiles - 1]
    const cosLat = Math.max(0.15, Math.cos(center.lat * DEG));
    const pad = 1.15;
    const latPad = (rangeNm / 60) * pad;
    const lonPad = (rangeNm / (60 * cosLat)) * pad;

    const xMin = lon2tileX(center.lon - lonPad, z);
    const xMax = lon2tileX(center.lon + lonPad, z);
    const yMin = lat2tileY(center.lat + latPad, z); // north → smaller y
    const yMax = lat2tileY(center.lat - latPad, z);
    if ((xMax - xMin + 1) * (yMax - yMin + 1) > MAX_TILES) return;

    const sx = maxR / rangeNm; // pixels per nautical mile
    const proj = (lat, lon) => ({
      x: cx + (lon - center.lon) * 60 * cosLat * sx,
      y: cy - (lat - center.lat) * 60 * sx,
    });

    ctx.save();
    if (!background) {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.clip();
    }
    // Match the radar's heading rotation (north-up projection + rotate frame).
    ctx.translate(cx, cy);
    ctx.rotate(-(cfg.heading || 0) * DEG);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.imageSmoothingEnabled = true;
    // Optional blend (e.g. terrain "multiply") — ctx.save above captures the
    // composite op so ctx.restore below resets it to "source-over".
    ctx.globalCompositeOperation = blend || "source-over";

    const skipWater = layerOpts && layerOpts.skipWater;
    const waterPolys = layerOpts && layerOpts.waterPolys;
    const minBytes = layerOpts && layerOpts.minBytes;

    for (let x = xMin; x <= xMax; x++) {
      // Skip tiles whose column/row fall outside the slippy-map grid (can happen
      // near the antimeridian or poles); those URLs return a placeholder/404.
      if (x < 0 || x >= nTiles) continue;
      for (let y = yMin; y <= yMax; y++) {
        if (y < 0 || y >= nTiles) continue;
        if (skipWater && waterPolys) {
          const c = tileCenterLonLat(x, y, z);
          if (pointInWater(c.lon, c.lat, waterPolys)) continue;
        }
        const img = getTile(urlFn(x, y, z), onReady, minBytes ? { minBytes } : null);
        if (!img) continue;
        const nw = proj(tileY2lat(y, z), tileX2lon(x, z));
        const se = proj(tileY2lat(y + 1, z), tileX2lon(x + 1, z));
        const w = se.x - nw.x;
        const h = se.y - nw.y;
        if (w <= 0 || h <= 0) continue;
        // +1px overdraw hides hairline seams from sub-pixel rounding.
        ctx.drawImage(img, nw.x, nw.y, w + 1, h + 1);
      }
    }
    if (background) applyBackgroundLayerFade(ctx, cx, cy, maxR);
    ctx.restore();
  }

  // Esri World Hillshade serves real relief on land through ~z16, but beyond its
  // cached zoom (and over open ocean / no-elevation areas at ANY zoom) it returns
  // a light-grey "Map data not yet available" placeholder JPEG (~2.5 KB, constant
  // size). We can't read tile pixels at runtime (no CORS), so we can't detect the
  // placeholder after the fact — instead we (a) cap the zoom well inside the
  // real-data range, verified by fetching tiles at DTW/London/Alaska/N. Norway
  // (all return >5 KB real relief at z13), and (b) in background mode draw the
  // tiles faintly with "multiply" so the opaque near-white hillshade — and any
  // residual ocean placeholder — only shade the page rather than wash it out.
  const TERRAIN_MAX_Z = 13;
  // RainViewer's public tile cache (tilecache.rainviewer.com /256/ path) only
  // serves real radar through zoom 7. Requesting z8+ returns a fixed ~1.4 KB
  // grey "Zoom Level Not Supported" placeholder PNG (verified by fetching tiles
  // at DTW/Pacific/Alaska/N. Norway — every z>=8 tile was the identical 1370-byte
  // placeholder, while z<=7 returned varied real precip data). We load tiles via
  // <img> without CORS, so we can't inspect the bytes/pixels to skip it after the
  // fact — the only reliable lever is to never request beyond the supported zoom.
  const WEATHER_MAX_Z = 7;

  function drawTerrain(ctx, cx, cy, maxR, cfg, center, opacity, onReady) {
    // Hillshade JPEGs are nearly white on land; Esri serves a flat light-grey
    // "no data" placeholder over ocean. Drawing either at full opacity inside
    // the circular scope clip produces a visible grey/white disc. We (a) skip
    // ocean tiles via the water polygon mask, (b) reject placeholder tiles by
    // byte size in the service worker before loading, and (c) always shade with
    // multiply + moderated alpha so relief reads as subtle terrain, not a disc.
    const background = cfg && cfg.mode === "background";
    const eff = background ? Math.min(opacity * 0.35, 0.28) : Math.min(opacity * 0.72, 0.5);
    const waterPolys = ensureWater(onReady);
    drawLayer(
      ctx, cx, cy, maxR, cfg, center,
      (x, y, z) =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`,
      eff, onReady, TERRAIN_MAX_Z, "multiply",
      { skipWater: true, waterPolys, minBytes: TERRAIN_MIN_BYTES }
    );
  }

  function drawWeather(ctx, cx, cy, maxR, cfg, center, opacity, onReady) {
    const w = ensureWeather(onReady);
    if (!w) return;
    const background = cfg && cfg.mode === "background";
    const eff = background ? Math.min(opacity * 0.85, 0.55) : opacity;
    drawLayer(
      ctx, cx, cy, maxR, cfg, center,
      (x, y, z) => `${w.host}${w.path}/256/${z}/${x}/${y}/2/1_1.png`,
      eff, onReady, WEATHER_MAX_Z, background ? "multiply" : "source-over",
      { minBytes: 1500 }
    );
  }

  // Translucent blue used for the water fill (alpha comes from the layer opacity).
  const WATER_COLOR = "#1f6fb2";

  function ringBBox(ring) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
  }

  // Flatten the GeoJSON FeatureCollection into a list of polygons (outer ring +
  // holes) each tagged with the bbox of its outer ring, so drawing can cheaply
  // skip everything outside the visible lat/lon window.
  function flattenWater(fc) {
    const out = [];
    for (const f of fc.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const rings of polys) {
        if (!rings || !rings[0] || rings[0].length < 4) continue;
        out.push({ bbox: ringBBox(rings[0]), rings });
      }
    }
    return out;
  }

  function loadWaterViaBackground() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "get-water" }, (res) => {
          void chrome.runtime?.lastError;
          if (res && res.ok && res.water) resolve(res.water);
          else reject(new Error(res?.error || "water fetch failed"));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // Lazy-load the bundled water polygons once. Falls back to the CSP-exempt
  // service worker when a page CSP blocks the content-script fetch. Calls
  // onReady once the data is parsed so the radar can redraw with water shown.
  function ensureWater(onReady) {
    if (waterPolys || waterPending || waterFailed) return waterPolys;
    waterPending = true;
    const finish = (fc) => {
      waterPending = false;
      if (!fc) {
        waterFailed = true;
        return;
      }
      waterPolys = flattenWater(fc);
      if (typeof onReady === "function") onReady();
    };
    (async () => {
      try {
        const url = chrome.runtime.getURL("src/data/water.geo.json");
        try {
          finish(await fetch(url).then((r) => r.json()));
        } catch (_) {
          finish(await loadWaterViaBackground());
        }
      } catch (_) {
        finish(null);
      }
    })();
    return waterPolys;
  }

  function drawWater(ctx, cx, cy, maxR, cfg, center, opacity, onReady) {
    if (!center || center.lat == null || !(opacity > 0) || maxR <= 0) return;
    const polys = ensureWater(onReady);
    if (!polys) return;

    const rangeNm = cfg.rangeNm || 40;
    const cosLat = Math.max(0.15, Math.cos(center.lat * DEG));
    const pad = 1.2;
    const latPad = (rangeNm / 60) * pad;
    const lonPad = (rangeNm / (60 * cosLat)) * pad;
    const win = {
      minLon: center.lon - lonPad,
      maxLon: center.lon + lonPad,
      minLat: center.lat - latPad,
      maxLat: center.lat + latPad,
    };
    const sx = maxR / rangeNm; // pixels per nautical mile
    const proj = (lat, lon) => ({
      x: cx + (lon - center.lon) * 60 * cosLat * sx,
      y: cy - (lat - center.lat) * 60 * sx,
    });

    const background = cfg && cfg.mode === "background";

    ctx.save();
    if (!background) {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.clip();
    }
    // Match the radar's heading rotation (north-up projection + rotate frame).
    ctx.translate(cx, cy);
    ctx.rotate(-(cfg.heading || 0) * DEG);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.fillStyle = WATER_COLOR;

    for (const poly of polys) {
      const b = poly.bbox;
      if (b[2] < win.minLon || b[0] > win.maxLon || b[3] < win.minLat || b[1] > win.maxLat) continue;
      ctx.beginPath();
      for (const ring of poly.rings) {
        for (let i = 0; i < ring.length; i++) {
          const p = proj(ring[i][1], ring[i][0]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      // evenodd so inner rings (continents inside the ocean polygon) punch holes.
      ctx.fill("evenodd");
    }
    if (background) applyBackgroundLayerFade(ctx, cx, cy, maxR);
    ctx.restore();
  }

  return { drawWeather, drawTerrain, drawWater };
})();
