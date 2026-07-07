// Flight Tracker world map — flat (equirectangular w/ cos-lat correction)
// projection that auto-fits to the route, draws country / US-state outlines,
// airport dots, the planned great-circle, and the live aircraft + actual trail.
window.SKWorldMap = (() => {
  const COL = {
    ocean: "#040a0c",
    land: "#0c1c11",
    country: "#1f5c33",
    state: "rgba(110, 200, 154, 0.28)",
    planned: "#7dffa6",
    actual: "#ffd966",
    dep: "#7dffa6",
    arr: "#ff9f6b",
    live: "#ffffff",
    label: "#bfe9cc",
  };

  // Continental-US bounding box; states are only drawn when the whole view sits
  // inside this, to keep international maps clean.
  const US_BOX = { minLat: 22, maxLat: 52, minLon: -130, maxLon: -64 };

  // Minimum half-span (degrees, from the view center). Used for the live-only
  // case (a lone aircraft with no route yet) and to guard a route that collapses
  // to a single point, so we never zoom in infinitely. There is intentionally NO
  // maximum cap: when a route is known the full path drives the zoom, so even a
  // transcontinental flight is shown edge-to-edge.
  const MIN_HALF_LAT = 1.6;
  const MIN_HALF_LON = 1.6;

  let cache = null;

  function loadViaBackground() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "get-geojson" }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok) resolve({ world: res.world, states: res.states });
          else reject(new Error(res?.error || "geojson fetch failed"));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function load() {
    if (cache) return cache;
    const url = (p) => chrome.runtime.getURL(p);
    try {
      const [world, states] = await Promise.all([
        fetch(url("src/data/world-countries.geo.json")).then((r) => r.json()),
        fetch(url("src/data/us-states.geo.json")).then((r) => r.json()),
      ]);
      cache = { world, states };
    } catch (_) {
      // Page CSP may block a content-script fetch of the bundled data — ask the
      // background service worker (CSP-exempt) to load it instead.
      cache = await loadViaBackground();
    }
    return cache;
  }

  function eachRing(feature, fn) {
    const g = feature.geometry;
    if (!g) return;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) fn(ring);
  }

  function liveOf(model) {
    const l = model && model.live;
    if (l && Number.isFinite(l.lon) && Number.isFinite(l.lat)) return l;
    return null;
  }

  function collectPoints(model) {
    const pts = [];
    const add = (lon, lat) => {
      if (lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
    };
    if (model.dep) add(model.dep.lon, model.dep.lat);
    if (model.arr) add(model.arr.lon, model.arr.lat);
    (model.planned || []).forEach((seg) => seg.forEach(([lon, lat]) => add(lon, lat)));
    (model.actual || []).forEach(([lon, lat]) => add(lon, lat));
    const live = liveOf(model);
    if (live) add(live.lon, live.lat);
    return pts;
  }

  function hasRoute(model) {
    return !!(
      model.dep ||
      model.arr ||
      (model.planned && model.planned.length) ||
      (model.actual && model.actual.length)
    );
  }

  // Auto-zoom to fit the ENTIRE flight path. When a route is known we frame the
  // bounding box of everything — departure, destination, the live aircraft, and
  // the flown trace — with modest padding so the whole path is visible
  // edge-to-edge and fills the canvas. The full route drives the zoom (no max
  // cap), so transcontinental flights are shown in full. When only the live
  // position is available we keep a sensible default zoom around the plane, and
  // we only fall back to a wide view when there's no data at all.
  function computeBounds(model) {
    const pts = collectPoints(model);
    const live = liveOf(model);

    if (!pts.length && !live) {
      // No usable data — a modest default rather than the whole globe.
      return { minLat: -45, maxLat: 60, minLon: -120, maxLon: 60 };
    }

    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const [lon, lat] of pts) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    // Live-only (no route yet): keep a sensible default zoom on the plane.
    if (!hasRoute(model)) {
      const cLat = live ? live.lat : (minLat + maxLat) / 2;
      const cLon = live ? live.lon : (minLon + maxLon) / 2;
      return {
        minLat: cLat - MIN_HALF_LAT,
        maxLat: cLat + MIN_HALF_LAT,
        minLon: cLon - MIN_HALF_LON,
        maxLon: cLon + MIN_HALF_LON,
      };
    }

    // Fit the whole route. Guard against a degenerate (near-zero) span so a route
    // that has briefly collapsed to a point isn't zoomed in infinitely; aspect
    // ratio is preserved later by makeProjector.
    const cLat = (minLat + maxLat) / 2;
    const cLon = (minLon + maxLon) / 2;
    const spanLat = Math.max(maxLat - minLat, MIN_HALF_LAT * 2);
    const spanLon = Math.max(maxLon - minLon, MIN_HALF_LON * 2);
    const padLat = spanLat * 0.12;
    const padLon = spanLon * 0.12;

    return {
      minLat: cLat - spanLat / 2 - padLat,
      maxLat: cLat + spanLat / 2 + padLat,
      minLon: cLon - spanLon / 2 - padLon,
      maxLon: cLon + spanLon / 2 + padLon,
    };
  }

  function makeProjector(bounds, w, h) {
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const midLon = (bounds.minLon + bounds.maxLon) / 2;
    const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const lonSpan = Math.max(0.01, (bounds.maxLon - bounds.minLon) * cosLat);
    const latSpan = Math.max(0.01, bounds.maxLat - bounds.minLat);
    const scale = Math.min(w / lonSpan, h / latSpan) * 0.94;
    return (lon, lat) => ({
      x: w / 2 + (lon - midLon) * cosLat * scale,
      y: h / 2 - (lat - midLat) * scale,
    });
  }

  function drawFeatures(ctx, fc, project, stroke, fill, lineWidth) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    for (const f of fc.features) {
      ctx.beginPath();
      eachRing(f, (ring) => {
        for (let i = 0; i < ring.length; i++) {
          const p = project(ring[i][0], ring[i][1]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      });
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill("nonzero");
      }
      ctx.stroke();
    }
  }

  function boundsInsideUS(b) {
    return (
      b.minLat >= US_BOX.minLat - 6 &&
      b.maxLat <= US_BOX.maxLat + 6 &&
      b.minLon >= US_BOX.minLon - 6 &&
      b.maxLon <= US_BOX.maxLon + 6
    );
  }

  function drawPolyline(ctx, project, lonlatPts, color, width, dash, glow) {
    if (!lonlatPts || lonlatPts.length < 2) return;
    ctx.save();
    if (glow) {
      ctx.strokeStyle = glow;
      ctx.lineWidth = width + 3;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      lonlatPts.forEach(([lon, lat], i) => {
        const p = project(lon, lat);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    lonlatPts.forEach(([lon, lat], i) => {
      const p = project(lon, lat);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawAirport(ctx, project, ap, color, label) {
    if (!ap || ap.lat == null) return;
    const p = project(ap.lon, ap.lat);
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (label) {
      ctx.font = "bold 12px 'Consolas','Courier New',monospace";
      ctx.fillStyle = COL.label;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(label, p.x + 8, p.y - 4);
    }
    ctx.restore();
  }

  function drawLive(ctx, project, live, nowMs) {
    if (!live || live.lat == null) return;
    const p = project(live.lon, live.lat);
    const hdg = ((live.track || 0) * Math.PI) / 180;
    const t = (nowMs % 1600) / 1600;
    ctx.save();
    // expanding pulse so the eye is drawn to the aircraft's position
    ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.85})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11 + t * 20, 0, Math.PI * 2);
    ctx.stroke();
    // steady ring around the marker
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.stroke();
    // aircraft triangle — larger and outlined so it reads over land/route
    ctx.translate(p.x, p.y);
    ctx.rotate(hdg);
    ctx.fillStyle = COL.live;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7.5, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7.5, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function draw(ctx, w, h, model, nowMs, opts) {
    const data = cache;

    // `backdropAlpha` dims ONLY the base map (ocean + land / country / state
    // outlines). The page behind the canvas shows through it as a subtle
    // backdrop, while the route, trail, airports and the live aircraft are
    // always drawn at full opacity on top so the tracked flight stays crisp and
    // clearly visible. Defaults to 1 (fully opaque base map) when no caller
    // passes a value, preserving the legacy look for any other consumer.
    const backdropAlpha = opts && opts.backdropAlpha != null
      ? Math.max(0, Math.min(1, opts.backdropAlpha))
      : 1;

    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = backdropAlpha;
    ctx.fillStyle = COL.ocean;
    ctx.fillRect(0, 0, w, h);
    if (!data) {
      ctx.restore();
      return;
    }

    const bounds = computeBounds(model);
    const project = makeProjector(bounds, w, h);

    drawFeatures(ctx, data.world, project, COL.country, COL.land, 1);
    if (boundsInsideUS(bounds)) {
      drawFeatures(ctx, data.states, project, COL.state, null, 0.75);
    }
    ctx.restore();

    (model.planned || []).forEach((seg) =>
      drawPolyline(ctx, project, seg, COL.planned, 2.75, [8, 5], "rgba(125,255,166,0.55)")
    );
    if (model.actual && model.actual.length > 1) {
      drawPolyline(ctx, project, model.actual, COL.actual, 3, [], "rgba(255,217,102,0.45)");
    }

    drawAirport(ctx, project, model.dep, COL.dep, model.dep && (model.dep.iata || model.dep.icao));
    drawAirport(ctx, project, model.arr, COL.arr, model.arr && (model.arr.iata || model.arr.icao));
    drawLive(ctx, project, model.live, nowMs || 0);
  }

  return { load, draw };
})();
