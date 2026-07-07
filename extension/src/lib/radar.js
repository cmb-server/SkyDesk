// ATC-style PPI radar — phosphor green, range rings, sweep, runway overlay.
window.SKRadar = (() => {
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const ATC = {
    bg: "#040804",
    dim: "#1a5c2a",
    ring: "#2a8a42",
    bright: "#4dff7a",
    phosphor: "#66ff99",
    sweep: "rgba(50, 255, 100, 0.22)",
    runway: "#b8ffc8",
    rwyLabel: "#7adf96",
    terminal: "#6ec89a",
    terminalFill: "#143820",
    mil: "#ffcc55",
    tag: "#55ee88",
    tagBg: "#d0d0d0",
    emergency: "#ff3b30",
    overhead: "#4de8ff",
  };
  let PAL = { ...ATC };

  const EMERGENCY_SQUAWKS = { "7500": "HIJACK", "7600": "NORDO", "7700": "EMERGENCY" };
  const EMERGENCY_STATES = {
    general: "EMERGENCY",
    lifeguard: "LIFEGUARD",
    minfuel: "MIN FUEL",
    nordo: "NORDO",
    unlawful: "HIJACK",
    downed: "DOWNED",
  };

  // Returns { code, label } when an aircraft is squawking an emergency code or
  // reporting an ADS-B emergency state, otherwise null.
  function emergencyInfo(ac) {
    if (!ac) return null;
    const sq = String(ac.squawk == null ? "" : ac.squawk).trim();
    if (EMERGENCY_SQUAWKS[sq]) return { code: sq, label: EMERGENCY_SQUAWKS[sq] };
    const em = String(ac.emergency == null ? "" : ac.emergency).trim().toLowerCase();
    if (em && em !== "none" && em !== "reserved") {
      return { code: sq || "EMG", label: EMERGENCY_STATES[em] || "EMERGENCY" };
    }
    return null;
  }

  function palette(cfg) {
    const p = { ...ATC };
    if (cfg?.colorPlane) p.phosphor = cfg.colorPlane;
    if (cfg?.colorMilitary) p.mil = cfg.colorMilitary;
    if (cfg?.colorTag) p.tag = cfg.colorTag;
    if (cfg?.colorTagBg) p.tagBg = cfg.colorTagBg;
    if (cfg?.colorAirport) {
      p.bright = cfg.colorAirport;
    }
    if (cfg?.colorRings) {
      p.ring = cfg.colorRings;
      p.dim = cfg.colorRings;
    }
    if (cfg?.colorRunway) {
      p.runway = cfg.colorRunway;
      p.rwyLabel = cfg.colorRunway;
    }
    return p;
  }
  const FT_PER_NM = 6076.12;

  function isGroundMode(cfg) {
    return !!(cfg?.proGroundMode && cfg.centerMode === "airport" && cfg.icao);
  }

  function effectiveRangeNm(cfg) {
    return isGroundMode(cfg) ? cfg.groundRangeNm || 2.5 : cfg.rangeNm || 40;
  }

  function maxRadius(w, h, cfg) {
    const ground = isGroundMode(cfg);
    // Ground mode renders the airfield larger so runways/taxiways are easy to
    // read; normal radar sizing is unchanged.
    return Math.min(w, h) * (ground ? 0.72 : cfg.mode === "background" ? 0.44 : 0.38);
  }

  function classify(ac) {
    const fl = (ac.flight || "").trim().toUpperCase();
    const t = (ac.t || "").toUpperCase();
    if (ac.dbFlags & 1 || /^(RCH|REACH|NINJA|EVAC|HOMER|IRON)/.test(fl)) return "military";
    // Exact type designators only — anchored so "C17" can't match the GA "C172"
    // (Cessna 172) or "C5" the Cessna Citation series (C525/C550/…).
    if (/^(C17|C130|C30J|KC10|KC46|KC135|F15|F16|F18|F22|F35|B52|V22|C5|C5M|T38|U28)$/.test(t)) return "military";
    // Light/GA type designators.
    if (
      ac.category === "A1" ||
      /^(C72|C82|C152|C162|C172|C177|C182|C206|C210|C310|PA(18|24|28|32|34|44|46)|P28A|SR2[02]|BE(9L|20|36|55|58)|DA[24]0|DA62|M20|PC12|TBM[0-9])/.test(t)
    ) {
      return "ga";
    }
    // Registration / tail-number callsigns are general aviation, never airline.
    if (/^N[1-9]/.test(fl)) return "ga"; // US N-numbers
    if (/^[A-Z]{1,2}-[A-Z0-9]{2,5}$/.test(fl)) return "ga"; // hyphenated regs (G-ABCD, D-EFGH…)
    // Airline callsigns are an ICAO telephony prefix (3 letters) + flight number.
    if (/^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(fl)) return "airline";
    // Anything else (bare regs, unknown) defaults to GA rather than airline.
    return "ga";
  }

  function filterAircraft(list, cfg) {
    const range = effectiveRangeNm(cfg);
    const showEmg = cfg.showEmergency !== false;
    const isEmg = (ac) => showEmg && emergencyInfo(ac);
    return list
      .filter((ac) => {
        // Emergencies bypass category / speed filters but still must be in range.
        if (!isEmg(ac)) {
          const k = classify(ac);
          if (k === "military" && !cfg.showMilitary) return false;
          if (k === "ga" && !cfg.showGa) return false;
          if (k === "airline" && !cfg.showAirlines) return false;
          if (isGroundMode(cfg)) {
            const gs = ac.gs;
            if (gs != null && Number.isFinite(gs) && gs > 150) return false;
            const alt = ac.alt_baro;
            if (gs == null && alt != null && Number.isFinite(alt) && alt > 3500) return false;
          } else if (cfg.hideUnder80Kts) {
            const gs = ac.gs;
            if (gs != null && Number.isFinite(gs) && gs < 80) return false;
          }
        }
        return (ac.dst || 0) <= range;
      })
      // Keep emergencies first so they always survive the maxBlips cap.
      .sort((a, b) => {
        const ea = isEmg(a) ? 0 : 1;
        const eb = isEmg(b) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return (a.dst || 0) - (b.dst || 0);
      })
      .slice(0, cfg.maxBlips || 24);
  }

  function position(ac, cx, cy, maxR, cfg) {
    const range = effectiveRangeNm(cfg);
    const bearing = ((ac.dir || 0) - (cfg.heading || 0) + 360) % 360;
    const rad = (bearing * Math.PI) / 180;
    const frac = Math.min(1, (ac.dst || 0) / range);
    const r = maxR * frac;
    return {
      x: cx + Math.sin(rad) * r,
      y: cy - Math.cos(rad) * r,
      bearing,
    };
  }

  function ringDistances(rangeNm) {
    let step = 5;
    if (rangeNm <= 5) step = 1;
    else if (rangeNm <= 15) step = 2;
    else if (rangeNm > 60) step = 20;
    else if (rangeNm > 30) step = 10;
    const rings = [];
    for (let d = step; d < rangeNm; d += step) rings.push(d);
    rings.push(rangeNm);
    return [...new Set(rings)];
  }

  function hexA(color, a) {
    const m = color.match(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (!m) return color;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  function drawTerminals(ctx, cx, cy, maxR, cfg, airport, alpha, widget) {
    const geo = window.SKGeo;
    const terminals = airport?.terminals || [];
    if (!geo || !terminals.length) return;

    const background = cfg.mode === "background";
    const fillA = background ? alpha * 0.28 : alpha * 0.7;

    for (const t of terminals) {
      const ring = t.ring;
      if (!ring || ring.length < 3) continue;

      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const p = geo.toRadarXY(airport, ring[i].lat, ring[i].lon, cx, cy, maxR, cfg);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();

      ctx.fillStyle = hexA(PAL.terminalFill, fillA);
      ctx.fill();
      ctx.strokeStyle = hexA(PAL.terminal, alpha * 0.9);
      ctx.lineWidth = widget ? 1.25 : 2;
      ctx.stroke();

      if (t.lat == null || t.lon == null) continue;
      const cen = geo.toRadarXY(airport, t.lat, t.lon, cx, cy, maxR, cfg);
      const text = t.label || "?";
      ctx.fillStyle = hexA(PAL.rwyLabel, alpha * 0.96);
      ctx.font = `bold ${widget ? 8 : 11}px "Consolas", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cen.x, cen.y);
    }
  }

  function drawBackground(ctx, w, h, cfg, alpha, widget, background) {
    // Background mode: fully transparent canvas — radar draws over the page, no tint.
    if (background) return;

    ctx.fillStyle = ATC.bg;
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.38;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.15);
    g.addColorStop(0, hexA("#081208", alpha * 0.98));
    g.addColorStop(1, hexA("#020402", alpha * 1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + (widget ? 8 : 0), 0, Math.PI * 2);
    ctx.fill();
  }

  function gridAlpha(cfg, baseAlpha) {
    const pct = cfg.ringOpacity ?? 100;
    return baseAlpha * Math.min(1, Math.max(0, pct) / 100);
  }

  function homeMarkerAlpha(cfg, baseAlpha) {
    const pct = cfg.homeMarkerOpacity ?? 90;
    return baseAlpha * Math.min(1, Math.max(0, pct) / 100);
  }

  function drawRangeRings(ctx, cx, cy, maxR, cfg, alpha, widget) {
    const rings = ringDistances(effectiveRangeNm(cfg));
    const ringA = gridAlpha(cfg, alpha);
    ctx.font = `${widget ? 7 : 9}px "Consolas", "Courier New", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const nm of rings) {
      const f = nm / effectiveRangeNm(cfg);
      const r = maxR * f;
      const isOuter = nm === effectiveRangeNm(cfg);
      if (isOuter && cfg.showOuterRing === false) continue;
      ctx.beginPath();
      ctx.strokeStyle = hexA(PAL.ring, ringA * (isOuter ? 0.75 : 0.45));
      ctx.lineWidth = isOuter ? (widget ? 1 : 1.5) : 0.75;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      if (!widget || isOuter) {
        ctx.fillStyle = hexA(PAL.ring, ringA * 0.75);
        ctx.fillText(`${nm}`, cx + 4, cy - r + (widget ? 8 : 10));
      }
    }
  }

  function drawBearingMarks(ctx, cx, cy, maxR, cfg, alpha, widget) {
    const ringA = gridAlpha(cfg, alpha);
    for (let deg = 0; deg < 360; deg += 30) {
      const a = ((deg - (cfg.heading || 0)) + 360) % 360;
      const rad = (a * Math.PI) / 180;
      const major = deg % 90 === 0;
      const inner = maxR * (major ? 0.88 : 0.93);
      const x1 = cx + Math.sin(rad) * inner;
      const y1 = cy - Math.cos(rad) * inner;
      const x2 = cx + Math.sin(rad) * maxR;
      const y2 = cy - Math.cos(rad) * maxR;
      ctx.beginPath();
      ctx.strokeStyle = hexA(PAL.ring, ringA * (major ? 0.75 : 0.45));
      ctx.lineWidth = major ? 1.25 : 0.75;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      if (major && !widget) {
        const lx = cx + Math.sin(rad) * (maxR + 14);
        const ly = cy - Math.cos(rad) * (maxR + 14);
        const label = deg === 0 ? "N" : deg === 90 ? "E" : deg === 180 ? "S" : "W";
        ctx.fillStyle = hexA(PAL.ring, ringA * 0.85);
        ctx.font = `10px "Consolas", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx, ly);
      }
    }
  }

  function drawSweep(ctx, cx, cy, maxR, sweepDeg, cfg, alpha) {
    if (sweepDeg == null) return;
    const a = ((sweepDeg - (cfg.heading || 0)) + 360) % 360;
    const rad = (a * Math.PI) / 180;
    const wedge = 0.09;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, rad - wedge, rad + wedge);
    ctx.closePath();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    g.addColorStop(0, hexA("#33ff66", alpha * 0.08));
    g.addColorStop(0.6, hexA("#33ff66", alpha * 0.14));
    g.addColorStop(1, hexA("#33ff66", 0));
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = hexA(PAL.bright, alpha * 0.55);
    ctx.lineWidth = 1.5;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(rad) * maxR, cy - Math.cos(rad) * maxR);
    ctx.stroke();
  }

  function drawRunways(ctx, cx, cy, maxR, cfg, airport, alpha, widget) {
    const runways = airport?.runways || [];
    const geo = window.SKGeo;

    if (!runways.length || !geo) {
      ctx.strokeStyle = hexA(PAL.runway, alpha * 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - maxR * 0.08, cy);
      ctx.lineTo(cx + maxR * 0.08, cy);
      ctx.moveTo(cx, cy - maxR * 0.08);
      ctx.lineTo(cx, cy + maxR * 0.08);
      ctx.stroke();
      return;
    }

    for (const rw of runways) {
      let x1, y1, x2, y2, label, wide;

      if (rw.le_lat != null && rw.he_lat != null) {
        const p1 = geo.toRadarXY(airport, rw.le_lat, rw.le_lon, cx, cy, maxR, cfg);
        const p2 = geo.toRadarXY(airport, rw.he_lat, rw.he_lon, cx, cy, maxR, cfg);
        x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
        label = rw.le_ident || (rw.rwy || "").split("/")[0];
        wide = (rw.widthFt || 100) >= 150;
      } else if (rw.hdg != null) {
        const hdg = ((rw.hdg - (cfg.heading || 0)) + 360) % 360;
        const rad = (hdg * Math.PI) / 180;
        const lenNm = (rw.lenFt || 5000) / FT_PER_NM;
        const halfPx = Math.min(maxR * 0.92, maxR * (lenNm / effectiveRangeNm(cfg)) * 0.5);
        x1 = cx - Math.sin(rad) * halfPx;
        y1 = cy + Math.cos(rad) * halfPx;
        x2 = cx + Math.sin(rad) * halfPx;
        y2 = cy - Math.cos(rad) * halfPx;
        label = (rw.rwy || "").split("/")[0];
        wide = (rw.widthFt || 100) >= 150;
      } else {
        continue;
      }

      ctx.strokeStyle = hexA(PAL.runway, alpha * (wide ? 0.95 : 0.82));
      ctx.lineWidth = wide
        ? isGroundMode(cfg)
          ? widget ? 4 : 5.5
          : widget ? 2 : 2.5
        : isGroundMode(cfg)
          ? widget ? 2 : 2.75
          : widget ? 1.25 : 1.75;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const perp = Math.atan2(dy, dx) + Math.PI / 2;
      const bar = isGroundMode(cfg) ? (widget ? 3 : 6) : widget ? 2 : 4;
      for (const sign of [-1, 1]) {
        const ex = sign === -1 ? x1 : x2;
        const ey = sign === -1 ? y1 : y2;
        ctx.beginPath();
        ctx.moveTo(ex + Math.cos(perp) * bar, ey + Math.sin(perp) * bar);
        ctx.lineTo(ex - Math.cos(perp) * bar, ey - Math.sin(perp) * bar);
        ctx.stroke();
      }

      if (label) {
        const lx = mx + (dx / len) * (isGroundMode(cfg) ? (widget ? 10 : 18) : widget ? 8 : 14);
        const ly = my + (dy / len) * (isGroundMode(cfg) ? (widget ? 10 : 18) : widget ? 8 : 14);
        ctx.fillStyle = hexA(PAL.rwyLabel, alpha * 0.85);
        ctx.font = `${isGroundMode(cfg) ? (widget ? 8 : 12) : widget ? 6 : 9}px "Consolas", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx, ly);
      }
    }
  }

  function drawAirport(ctx, cx, cy, airport, alpha, widget, cfg) {
    const ground = isGroundMode(cfg);
    if (ground) {
      const raw = airport?.info?.name || airport?.label || airport?.icao || "?";
      const label = raw.length > 28 ? `${raw.slice(0, 26)}…` : raw;
      ctx.fillStyle = hexA(PAL.phosphor, alpha * 0.92);
      ctx.font = `bold ${widget ? 11 : 16}px "Consolas", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, cx, cy - (widget ? 6 : 10));
      return;
    }

    if (cfg.showAirportDot !== false) {
      const r = widget ? 2 : 3;
      ctx.fillStyle = hexA(PAL.bright, alpha * 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const label = airport?.label || airport?.icao || "?";
    ctx.fillStyle = hexA(PAL.phosphor, alpha * 0.9);
    ctx.font = `${widget ? 8 : 11}px "Consolas", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, cx, cy + (widget ? 5 : 8));
  }

  // Amber crosshair at scope center — marks the lat/long watch center only.
  function drawHomeMarker(ctx, cx, cy, alpha, widget, cfg) {
    if (cfg.showHomeMarker === false) return;

    const gap = widget ? 2.5 : 4;
    const arm = widget ? 6 : 10;
    const ringR = widget ? 5 : 7.5;
    const base = cfg.homeMarkerColor || "#ffb84d";
    const markerA = homeMarkerAlpha(cfg, alpha);
    const col = hexA(base, markerA * 0.9);
    const glow = hexA(base, markerA * 0.35);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.strokeStyle = glow;
    ctx.lineWidth = widget ? 2.2 : 2.8;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * gap, cy + dy * gap);
      ctx.lineTo(cx + dx * arm, cy + dy * arm);
      ctx.stroke();
    }

    ctx.strokeStyle = col;
    ctx.lineWidth = widget ? 1 : 1.35;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * gap, cy + dy * gap);
      ctx.lineTo(cx + dx * arm, cy + dy * arm);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth = widget ? 0.85 : 1.1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, widget ? 1.2 : 1.8, 0, Math.PI * 2);
    ctx.fillStyle = hexA(base, markerA * 0.95);
    ctx.fill();

    ctx.restore();
  }

  function planeHeading(ac, cfg) {
    if (ac.track != null) return (((ac.track - (cfg.heading || 0)) + 360) % 360) * Math.PI / 180;
    if (ac.dir != null) return (((ac.dir - (cfg.heading || 0)) + 360) % 360) * Math.PI / 180;
    return 0;
  }

  function drawPlaneBlip(ctx, px, py, ac, cfg, col, alpha, sel, widget) {
    const hdg = planeHeading(ac, cfg);
    const base = widget ? 5 : sel ? 9 : 7;
    const scale = cfg.blipSize ? base * (cfg.blipSize / 9) : base;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(hdg);

    if (!widget) {
      ctx.beginPath();
      ctx.fillStyle = hexA(col, alpha * 0.18);
      ctx.arc(0, 0, scale * 1.35, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = hexA(col, alpha * (sel ? 1 : 0.92));
    ctx.moveTo(0, -scale);
    ctx.lineTo(scale * 0.55, scale * 0.85);
    ctx.lineTo(0, scale * 0.45);
    ctx.lineTo(-scale * 0.55, scale * 0.85);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = hexA(PAL.bright, alpha * 0.55);
    ctx.lineWidth = widget ? 0.6 : 0.85;
    ctx.stroke();
    ctx.restore();
  }

  function drawDotBlip(ctx, px, py, col, alpha, sel, widget) {
    if (!widget) {
      ctx.beginPath();
      ctx.fillStyle = hexA(col, alpha * 0.2);
      ctx.arc(px, py, sel ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.fillStyle = hexA(col, alpha * (sel ? 1 : 0.92));
    ctx.arc(px, py, sel ? 4 : widget ? 2.5 : 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = hexA(PAL.bright, alpha * 0.5);
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }

  function formatAlt(ac) {
    const a = ac.alt_baro;
    if (a == null || !Number.isFinite(a)) return null;
    if (a >= 18000) return `FL${Math.round(a / 100)}`;
    return `${Math.round(a)}'`;
  }

  function formatSpeed(ac) {
    const gs = ac.gs;
    if (gs == null || !Number.isFinite(gs)) return null;
    return `${Math.round(gs)}kt`;
  }

  function formatType(ac, widget) {
    const raw = (ac.t || ac.type || "").trim();
    if (raw) return raw.slice(0, widget ? 5 : 8);
    const kind = classify(ac);
    if (kind === "military") return "MIL";
    if (kind === "airline") return "AIR";
    if (kind === "ga") return "GA";
    return null;
  }

  function tagFontPx(cfg, widget) {
    const base = Math.max(7, Math.min(14, Number(cfg.tagFontSize) || 9));
    return widget ? Math.max(7, base - 2) : base;
  }

  const OVERHEAD_MAX_NM = 3;
  const OVERHEAD_MIN_GS = 40;

  function findOverheadAircraft(list, cfg) {
    if (!cfg || cfg.showOverheadHighlight === false || cfg.centerMode !== "coords") return null;
    let best = null;
    let bestDst = Infinity;
    for (const ac of list) {
      const dst = ac.dst;
      if (dst == null || !Number.isFinite(dst) || dst > OVERHEAD_MAX_NM) continue;
      const gs = ac.gs;
      if (gs != null && Number.isFinite(gs) && gs < OVERHEAD_MIN_GS) continue;
      if (dst < bestDst) {
        bestDst = dst;
        best = ac;
      }
    }
    return best;
  }

  function drawOverheadHalo(ctx, px, py, nowMs, alpha, widget) {
    const period = 1400;
    const t = (nowMs % period) / period;
    const base = widget ? 6 : 9;
    const r = base + t * (widget ? 7 : 12);
    ctx.save();
    ctx.strokeStyle = hexA(PAL.overhead, (0.55 + (1 - t) * 0.35) * alpha);
    ctx.lineWidth = widget ? 1.5 : 2;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = hexA(PAL.overhead, alpha * 0.85);
    ctx.lineWidth = widget ? 1.25 : 1.75;
    ctx.beginPath();
    ctx.arc(px, py, base, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawEmergencyHalo(ctx, px, py, nowMs, alpha, widget) {
    const period = 1100;
    const t = (nowMs % period) / period;
    const base = widget ? 7 : 10;
    const r = base + t * (widget ? 9 : 15);
    ctx.save();
    ctx.strokeStyle = hexA(PAL.emergency, (1 - t) * alpha);
    ctx.lineWidth = widget ? 1.5 : 2.25;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = hexA(PAL.emergency, alpha * 0.7);
    ctx.lineWidth = widget ? 1.25 : 1.75;
    ctx.beginPath();
    ctx.arc(px, py, base, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function buildTagLines(ac, cfg, widget, emg, overhead) {
    const fl = (ac.flight || ac.r || ac.hex || "?").trim();
    const line1 = fl.slice(0, widget ? 7 : 10);
    if (emg) {
      const meta = [];
      if (cfg.showAltitude) {
        const alt = formatAlt(ac);
        if (alt) meta.push(alt);
      }
      if (cfg.showSpeed) {
        const spd = formatSpeed(ac);
        if (spd) meta.push(spd);
      }
      const lines = [`⚠ ${line1}`, emg.label];
      if (meta.length) lines.push(meta.join(" "));
      return lines;
    }
    const meta = [];
    if (cfg.showType) {
      const typ = formatType(ac, widget);
      if (typ) meta.push(typ);
    }
    if (cfg.showAltitude) {
      const alt = formatAlt(ac);
      if (alt) meta.push(alt);
    }
    if (cfg.showSpeed) {
      const spd = formatSpeed(ac);
      if (spd) meta.push(spd);
    }
    const lines = [line1];
    if (meta.length) lines.push(meta.join(" "));
    if (overhead) {
      const dst =
        ac.dst != null && Number.isFinite(ac.dst) ? `${ac.dst.toFixed(1)} nm` : "";
      lines.push(dst ? `OVERHEAD · ${dst}` : "OVERHEAD");
    }
    return lines;
  }

  function drawTracks(ctx, ac, px, py, cfg, alpha, widget, background) {
    if (ac.track == null) return;
    const tr = (((ac.track - (cfg.heading || 0)) + 360) % 360) * Math.PI / 180;
    const len = widget ? 8 : background ? 22 : 14;
    ctx.strokeStyle = hexA(PAL.phosphor, alpha * 0.45);
    ctx.lineWidth = widget ? 1 : 1.25;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.sin(tr) * len, py - Math.cos(tr) * len);
    ctx.stroke();
  }

  function drawDataTag(ctx, px, py, ac, cfg, alpha, widget, emg, overhead) {
    const lines = buildTagLines(ac, cfg, widget, emg, overhead);
    const fontPx = tagFontPx(cfg, widget);
    const lineH = fontPx + 2;
    ctx.font = `${fontPx}px "Consolas", "Courier New", monospace`;
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 6;
    const th = lines.length * lineH;
    const tx = px + (widget ? 5 : 8);
    const ty = py - (widget ? 4 : 6);

    if (cfg.showTagBg !== false || emg || overhead) {
      const bg = emg ? "#1a0606" : overhead ? "#061018" : PAL.tagBg;
      ctx.fillStyle = hexA(bg, alpha * (emg || overhead ? 0.82 : 0.88));
      ctx.fillRect(tx, ty - th + 2, tw, th);
      ctx.strokeStyle = hexA(
        emg ? PAL.emergency : overhead ? PAL.overhead : PAL.tagBg,
        alpha * 0.95
      );
      ctx.lineWidth = emg || overhead ? 1 : 0.75;
      ctx.strokeRect(tx, ty - th + 2, tw, th);
    }
    ctx.fillStyle = hexA(emg ? PAL.emergency : overhead ? PAL.overhead : PAL.tag, alpha * 0.97);
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    lines.forEach((line, i) => {
      ctx.fillText(line, tx + 3, ty - (lines.length - 1 - i) * lineH);
    });
  }

  function drawFlightPath(ctx, ac, route, center, cx, cy, maxR, cfg, alpha, widget) {
    if (!ac || ac._px == null) return;
    const geo = window.SKGeo;
    const track = ac.track ?? ac.dir ?? 0;
    const brg = ((track - (cfg.heading || 0)) + 360) % 360;
    const rad = (brg * Math.PI) / 180;
    const backNm = Math.min(Math.max(3, ac.dst || 5), 14);
    const fwdNm = Math.min(14, Math.max(2, (cfg.rangeNm || 40) - (ac.dst || 0)));
    const backR = maxR * (backNm / cfg.rangeNm);
    const fwdR = maxR * (fwdNm / cfg.rangeNm);

    ctx.save();
    ctx.strokeStyle = hexA(PAL.phosphor, alpha * 0.55);
    ctx.lineWidth = widget ? 1.25 : 1.75;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(ac._px - Math.sin(rad) * backR, ac._py + Math.cos(rad) * backR);
    ctx.lineTo(ac._px + Math.sin(rad) * fwdR, ac._py - Math.cos(rad) * fwdR);
    ctx.stroke();
    ctx.setLineDash([]);

    if (route && geo && center?.lat != null) {
      const apt = { lat: center.lat, lon: center.lon };
      const hasTrace = Array.isArray(route.trace) && route.trace.length > 1;
      const pts = [];
      if (hasTrace) {
        // Real flown path: project each [lon, lat] sample oldest→newest.
        for (const p of route.trace) {
          if (!Array.isArray(p) || p.length < 2) continue;
          pts.push(geo.toRadarXY(apt, p[1], p[0], cx, cy, maxR, cfg));
        }
      } else {
        if (route.dep?.lat != null) pts.push(geo.toRadarXY(apt, route.dep.lat, route.dep.lon, cx, cy, maxR, cfg));
        pts.push({ x: ac._px, y: ac._py });
        if (route.arr?.lat != null) pts.push(geo.toRadarXY(apt, route.arr.lat, route.arr.lon, cx, cy, maxR, cfg));
      }

      ctx.strokeStyle = hexA(PAL.tag, alpha * 0.8);
      ctx.lineWidth = widget ? 1.5 : 2.25;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();

      const dot = (p, label) => {
        if (!p || !label) return;
        ctx.fillStyle = hexA(PAL.bright, alpha * 0.9);
        ctx.beginPath();
        ctx.arc(p.x, p.y, widget ? 2.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hexA(PAL.tag, alpha * 0.95);
        ctx.font = `${widget ? 7 : 9}px "Consolas", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, p.x, p.y - 5);
      };
      if (hasTrace) {
        // Trace may not begin exactly at the departure airport, so anchor the
        // DEP/ARR markers to the actual route endpoints when known.
        if (route.dep?.lat != null) {
          dot(geo.toRadarXY(apt, route.dep.lat, route.dep.lon, cx, cy, maxR, cfg), route.dep.iata || route.dep.icao || "DEP");
        }
        if (route.arr?.lat != null) {
          dot(geo.toRadarXY(apt, route.arr.lat, route.arr.lon, cx, cy, maxR, cfg), route.arr.iata || route.arr.icao || "ARR");
        }
      } else {
        if (route.dep && pts[0]) dot(pts[0], route.dep.iata || route.dep.icao || "DEP");
        if (route.arr && pts.length > 1) {
          const ep = pts[pts.length - 1];
          dot(ep, route.arr.iata || route.arr.icao || "ARR");
        }
      }
    }
    ctx.restore();
  }

  function formatFlightCard(ac, route) {
    const fl = (ac.flight || ac.r || ac.hex || "?").trim();
    const lines = [
      `${ac.t || "unknown"} · ${ac.alt_baro?.toLocaleString() || "?"} ft`,
      `${Number.isFinite(ac.gs) ? ac.gs.toFixed(0) : "?"} kts · ${ac.dst?.toFixed(1)} nm`,
    ];
    if (route?.dep || route?.arr) {
      const from = route.dep
        ? `${route.dep.iata || route.dep.icao || "?"} ${route.dep.name ? `(${route.dep.name})` : ""}`
        : "?";
      const to = route.arr
        ? `${route.arr.iata || route.arr.icao || "?"} ${route.arr.name ? `(${route.arr.name})` : ""}`
        : "?";
      lines.push(`${from.trim()} → ${to.trim()}`);
    } else if (route === null) {
      lines.push("Looking up route…");
    } else if (route === false) {
      lines.push("Route unavailable");
    }
    return { title: fl, lines };
  }

  function draw(ctx, w, h, cfg, airport, aircraft, selected, routeInfo) {
    PAL = palette(cfg);
    const alpha = Math.min(1, (cfg.opacity || 30) / 100);
    const cx = w / 2;
    const cy = h / 2;
    const ground = isGroundMode(cfg);
    const background = cfg.mode === "background";
    const widget = cfg.mode === "widget";
    const maxR = maxRadius(w, h, cfg);
    const showTags = cfg.showLabels === true || cfg.showLabels === "full" || background || ground;

    ctx.clearRect(0, 0, w, h);
    drawBackground(ctx, w, h, cfg, alpha, widget, background);

    // Optional map layers drawn as the base map beneath rings, the airport and
    // all aircraft. Order matters: terrain first, then the blue water
    // fill over it (so land keeps its relief while oceans/lakes read as blue),
    // then weather radar on top. Each layer has its own independent opacity.
    const layers = typeof window !== "undefined" ? window.SKLayers : null;
    if (layers) {
      const lc =
        airport && airport.lat != null
          ? { lat: airport.lat, lon: airport.lon }
          : cfg.centerLat != null && cfg.centerLon != null
          ? { lat: cfg.centerLat, lon: cfg.centerLon }
          : null;
      if (lc) {
        if (cfg.showTerrain && (cfg.terrainOpacity ?? 0) > 0) {
          layers.drawTerrain(ctx, cx, cy, maxR, cfg, lc, (cfg.terrainOpacity ?? 60) / 100, cfg.onLayerReady);
        }
        if (cfg.showWater && (cfg.waterOpacity ?? 0) > 0) {
          layers.drawWater(ctx, cx, cy, maxR, cfg, lc, (cfg.waterOpacity ?? 70) / 100, cfg.onLayerReady);
        }
        if (cfg.showWeather && (cfg.weatherOpacity ?? 0) > 0) {
          layers.drawWeather(ctx, cx, cy, maxR, cfg, lc, (cfg.weatherOpacity ?? 70) / 100, cfg.onLayerReady);
        }
      }
    }

    if (cfg.showRangeRings !== false) {
      drawRangeRings(ctx, cx, cy, maxR, cfg, alpha, widget);
      drawBearingMarks(ctx, cx, cy, maxR, cfg, alpha, widget);
    }

    if (cfg.showSweep && cfg.sweepAngle != null) drawSweep(ctx, cx, cy, maxR, cfg.sweepAngle, cfg, alpha);

    if (cfg.centerMode === "airport" && airport) {
      if (cfg.showRunways !== false) {
        drawRunways(ctx, cx, cy, maxR, cfg, airport, alpha, widget);
      }
      if (ground) drawTerminals(ctx, cx, cy, maxR, cfg, airport, alpha, widget);
      drawAirport(ctx, cx, cy, airport, alpha, widget, cfg);
    }

    if (
      cfg.centerMode === "coords" &&
      cfg.centerLat != null &&
      cfg.centerLon != null &&
      cfg.showHomeMarker !== false
    ) {
      drawHomeMarker(ctx, cx, cy, alpha, widget, cfg);
    }

    const list = filterAircraft(aircraft, cfg);
    const drawCenter =
      airport ||
      (cfg.centerLat != null && cfg.centerLon != null
        ? { lat: cfg.centerLat, lon: cfg.centerLon }
        : null);

    if (selected && cfg.proFlightTrack) {
      drawFlightPath(
        ctx,
        selected,
        routeInfo,
        drawCenter,
        cx,
        cy,
        maxR,
        cfg,
        alpha,
        widget
      );
    }

    const usePre = cfg.usePrecomputed === true;
    const showEmg = cfg.showEmergency !== false;
    const overheadAc = findOverheadAircraft(list, cfg);
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    list.forEach((ac) => {
      let pxX, pxY;
      if (usePre && ac._px != null && ac._py != null) {
        pxX = ac._px;
        pxY = ac._py;
      } else {
        const pos = position(ac, cx, cy, maxR, cfg);
        pxX = pos.x;
        pxY = pos.y;
      }
      const kind = classify(ac);
      const sel = selected === ac;
      const emg = showEmg ? emergencyInfo(ac) : null;
      const overhead = overheadAc === ac && !emg;
      const col = emg
        ? PAL.emergency
        : overhead
          ? PAL.overhead
          : kind === "military"
            ? PAL.mil
            : PAL.phosphor;

      drawTracks(ctx, ac, pxX, pxY, cfg, alpha, widget, background);
      if (emg) drawEmergencyHalo(ctx, pxX, pxY, nowMs, alpha, widget);
      else if (overhead) drawOverheadHalo(ctx, pxX, pxY, nowMs, alpha, widget);

      if (cfg.blipStyle === "dot") {
        drawDotBlip(ctx, pxX, pxY, col, alpha, sel, widget);
      } else {
        drawPlaneBlip(ctx, pxX, pxY, ac, cfg, col, alpha, sel, widget);
      }

      if (showTags || emg || overhead) {
        drawDataTag(ctx, pxX, pxY, ac, cfg, alpha, widget, emg, overhead);
      }

      ac._px = pxX;
      ac._py = pxY;
    });

    return list;
  }

  function hitTest(list, x, y, radius = 12) {
    let best = null;
    let bestD = radius;
    for (const ac of list) {
      if (ac._px == null || ac._py == null) continue;
      const d = Math.hypot(x - ac._px, y - ac._py);
      if (d < bestD) {
        bestD = d;
        best = ac;
      }
    }
    return best;
  }

  function hitTestClient(list, canvas, clientX, clientY, radius = 14, logicalW, logicalH) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    const lw = logicalW || canvas.clientWidth || rect.width;
    const lh = logicalH || canvas.clientHeight || rect.height;
    const x = (clientX - rect.left) * (lw / rect.width);
    const y = (clientY - rect.top) * (lh / rect.height);
    return hitTest(list, x, y, radius);
  }

  function acKey(ac) {
    if (!ac) return null;
    return String(ac.hex || ac.flight || `${ac.lat},${ac.lon}`);
  }

  function formatCard(ac) {
    const fl = (ac.flight || ac.r || ac.hex || "?").trim();
    return {
      title: fl,
      lines: [
        `${ac.t || "unknown"} · ${ac.alt_baro?.toLocaleString() || "?"} ft`,
        `${Number.isFinite(ac.gs) ? ac.gs.toFixed(0) : "?"} kts · ${ac.dst?.toFixed(1)} nm`,
      ],
    };
  }

  function blendPositions(display, fresh, cx, cy, maxR, cfg, t) {
    const byKey = new Map(fresh.map((a) => [a.hex || a.flight || `${a.lat},${a.lon}`, a]));
    const out = [];
    for (const d of display) {
      const key = d.hex || d.flight || `${d.lat},${d.lon}`;
      const n = byKey.get(key);
      if (!n) continue;
      const tgt = position(n, cx, cy, maxR, cfg);
      const px = d._px != null ? d._px + (tgt.x - d._px) * t : tgt.x;
      const py = d._py != null ? d._py + (tgt.y - d._py) * t : tgt.y;
      out.push({ ...n, _px: px, _py: py });
      byKey.delete(key);
    }
    for (const n of byKey.values()) {
      const p = position(n, cx, cy, maxR, cfg);
      out.push({ ...n, _px: p.x, _py: p.y });
    }
    return out;
  }

  function normalizeTail(raw) {
    let s = String(raw || "").toUpperCase().replace(/[\s.-]/g, "");
    if (!s) return "";
    if (/^\d{1,5}[A-Z]{0,2}$/.test(s)) s = "N" + s;
    return s;
  }

  function acMatchesTail(ac, tailRaw) {
    const want = normalizeTail(tailRaw);
    if (!want || !ac) return false;
    const reg = normalizeTail(ac.r || ac.registration || "");
    if (reg && reg === want) return true;
    if (!reg) {
      const fl = String(ac.flight || "").trim().toUpperCase().replace(/[\s.-]/g, "");
      if (fl && fl === want) return true;
    }
    return false;
  }

  return {
    classify, filterAircraft, position, draw, hitTest, hitTestClient, acKey,
    isGroundMode, effectiveRangeNm, maxRadius, emergencyInfo, findOverheadAircraft,
    formatCard, formatFlightCard, blendPositions, COMPASS,
    normalizeTail, acMatchesTail,
  };
})();
