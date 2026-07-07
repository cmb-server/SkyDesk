// Shared geo helpers — PPI projection from lat/lon.
window.SKGeo = (() => {
  const NM_R = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;

  function nmDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return NM_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function destinationPoint(lat, lon, brgDeg, distNm) {
    const brg = toRad(brgDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distNm / NM_R) +
        Math.cos(lat1) * Math.sin(distNm / NM_R) * Math.cos(brg)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(distNm / NM_R) * Math.cos(lat1),
        Math.cos(distNm / NM_R) - Math.sin(lat1) * Math.sin(lat2)
      );
    return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
  }

  function offsetPoint(lat, lon, hdgDeg, alongNm, perpNm) {
    const along = destinationPoint(lat, lon, hdgDeg, alongNm);
    return destinationPoint(along.lat, along.lon, (hdgDeg + 90) % 360, perpNm);
  }

  /**
   * Great-circle interpolation between two points. Returns an array of
   * [lon, lat] segments (each an array of points); the path is split into
   * multiple segments when it crosses the antimeridian so a flat map can draw
   * each piece without a wrap-around streak.
   */
  function interpolateGreatCircle(lat1, lon1, lat2, lon2, steps = 96) {
    const φ1 = toRad(lat1);
    const λ1 = toRad(lon1);
    const φ2 = toRad(lat2);
    const λ2 = toRad(lon2);
    const d =
      2 *
      Math.asin(
        Math.sqrt(
          Math.sin((φ2 - φ1) / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
        )
      );

    const segments = [];
    let current = [];
    let prevLon = null;

    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      let lon, lat;
      if (d === 0 || !Number.isFinite(d)) {
        lon = lon1;
        lat = lat1;
      } else {
        const a = Math.sin((1 - f) * d) / Math.sin(d);
        const b = Math.sin(f * d) / Math.sin(d);
        const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
        const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
        const z = a * Math.sin(φ1) + b * Math.sin(φ2);
        lat = (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI;
        lon = (Math.atan2(y, x) * 180) / Math.PI;
      }
      if (prevLon != null && Math.abs(lon - prevLon) > 180) {
        if (current.length) segments.push(current);
        current = [];
      }
      current.push([lon, lat]);
      prevLon = lon;
    }
    if (current.length) segments.push(current);
    return segments;
  }

  /** Map a lat/lon to radar canvas x/y relative to airport center. */
  function toRadarXY(airport, lat, lon, cx, cy, maxR, cfg) {
    const rangeNm = cfg.rangeNm || 40;
    const dst = nmDistance(airport.lat, airport.lon, lat, lon);
    const dir = bearing(airport.lat, airport.lon, lat, lon);
    const brg = ((dir - (cfg.heading || 0)) + 360) % 360;
    const rad = (brg * Math.PI) / 180;
    const r = maxR * Math.min(1, dst / rangeNm);
    return {
      x: cx + Math.sin(rad) * r,
      y: cy - Math.cos(rad) * r,
      dst,
    };
  }

  return { nmDistance, bearing, destinationPoint, offsetPoint, toRadarXY, interpolateGreatCircle };
})();
