// Núcleo sin DOM: horario GTFS compacto, decodificador GTFS-Realtime y cálculo de llegadas.
// Se usa tal cual en el navegador (global BusCore) y en Node (module.exports) para el build y los tests.
var BusCore = (function () {
  "use strict";
  var TZ = "Europe/Madrid";

  // ---------- CSV ----------
  function splitQuoted(line) {
    var out = [], field = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(field); field = ""; }
      else field += c;
    }
    out.push(field);
    return out;
  }
  function parseCSV(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var lines = text.split("\n"), rows = [], head = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      // Campo entrecomillado con salto de línea dentro: juntar con la siguiente línea.
      while (line.split('"').length % 2 === 0 && i + 1 < lines.length) line += "\n" + lines[++i].replace(/\r$/, "");
      if (line === "") continue;
      var cells = line.indexOf('"') < 0 ? line.split(",") : splitQuoted(line);
      if (!head) { head = cells.map(function (h) { return h.trim(); }); continue; }
      var o = {};
      for (var k = 0; k < head.length; k++) o[head[k]] = cells[k] === undefined ? "" : cells[k].trim();
      rows.push(o);
    }
    return rows;
  }

  function hms(s) {
    if (!s) return null;
    var m = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(s);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
  }

  // ---------- Horario compacto a partir del GTFS ----------
  // get(nombre) devuelve el texto de un fichero del zip o null.
  function deriveSchedule(get) {
    function req(n) { var t = get(n); if (t == null) throw new Error("El GTFS no trae " + n); return t; }
    var routes = {};
    parseCSV(req("routes.txt")).forEach(function (r) {
      routes[r.route_id] = [r.route_short_name || r.route_id, r.route_long_name || "", (r.route_color || "").replace("#", "")];
    });
    var allStops = {};
    parseCSV(req("stops.txt")).forEach(function (s) {
      allStops[s.stop_id] = [s.stop_name, +(+s.stop_lat).toFixed(6), +(+s.stop_lon).toFixed(6)];
    });
    var dates = {};
    function add(d, s) { (dates[d] = dates[d] || {})[s] = 1; }
    var cal = get("calendar.txt");
    if (cal) parseCSV(cal).forEach(function (c) {
      var days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      var d = new Date(Date.UTC(+c.start_date.slice(0, 4), +c.start_date.slice(4, 6) - 1, +c.start_date.slice(6, 8)));
      var end = Date.UTC(+c.end_date.slice(0, 4), +c.end_date.slice(4, 6) - 1, +c.end_date.slice(6, 8));
      for (; d.getTime() <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        if (c[days[d.getUTCDay()]] === "1") add(d.toISOString().slice(0, 10).replace(/-/g, ""), c.service_id);
      }
    });
    var cd = get("calendar_dates.txt");
    if (cd) parseCSV(cd).forEach(function (c) {
      if (c.exception_type === "1") add(c.date, c.service_id);
      else if (c.exception_type === "2" && dates[c.date]) delete dates[c.date][c.service_id];
    });
    var trips = {};
    parseCSV(req("trips.txt")).forEach(function (t) { trips[t.trip_id] = t; });
    var byTrip = {};
    parseCSV(req("stop_times.txt")).forEach(function (st) {
      if (!trips[st.trip_id]) return;
      (byTrip[st.trip_id] = byTrip[st.trip_id] || []).push(st);
    });
    var patterns = [], pIndex = {}, svcTrips = {}, usedStops = {};
    Object.keys(byTrip).forEach(function (tid) {
      var sts = byTrip[tid].sort(function (a, b) { return a.stop_sequence - b.stop_sequence; });
      var times = sts.map(function (s) { return hms(s.arrival_time) != null ? hms(s.arrival_time) : hms(s.departure_time); });
      // Rellena horas vacías interpolando entre paradas con hora.
      var known = [];
      times.forEach(function (t, i) { if (t != null) known.push(i); });
      if (!known.length) return;
      for (var i = 0; i < times.length; i++) {
        if (times[i] != null) continue;
        var a = null, b = null;
        for (var k = 0; k < known.length; k++) { if (known[k] < i) a = known[k]; else if (b == null) b = known[k]; }
        if (a == null) times[i] = times[b]; else if (b == null) times[i] = times[a];
        else times[i] = Math.round(times[a] + (times[b] - times[a]) * (i - a) / (b - a));
      }
      var t0 = hms(sts[0].departure_time) != null ? hms(sts[0].departure_time) : times[0];
      var ids = sts.map(function (s) { usedStops[s.stop_id] = 1; return s.stop_id; });
      var seqs = sts.map(function (s) { return +s.stop_sequence; });
      var contiguous = seqs.every(function (v, i) { return v === i + 1; });
      var offs = times.map(function (t) { return t - t0; });
      var tr = trips[tid], dir = +(tr.direction_id || 0);
      var key = [tr.route_id, dir, tr.trip_headsign || "", ids.join(","), seqs.join(","), offs.join(",")].join("|");
      var pi = pIndex[key];
      if (pi === undefined) {
        pi = pIndex[key] = patterns.length;
        patterns.push([tr.route_id, dir, tr.trip_headsign || "", ids, offs, contiguous ? 0 : seqs]);
      }
      (svcTrips[tr.service_id] = svcTrips[tr.service_id] || []).push([pi, t0]);
    });
    var stops = {};
    Object.keys(usedStops).forEach(function (id) { if (allStops[id]) stops[id] = allStops[id]; });
    var outDates = {};
    Object.keys(dates).sort().forEach(function (d) {
      var s = Object.keys(dates[d]).filter(function (x) { return svcTrips[x]; });
      if (s.length) outDates[d] = s;
    });
    var fi = parseCSV(get("feed_info.txt") || "")[0] || {};
    var dl = Object.keys(outDates);
    return {
      v: 1,
      feed: { start: fi.feed_start_date || dl[0] || "", end: fi.feed_end_date || dl[dl.length - 1] || "", version: fi.feed_version || "" },
      routes: routes, stops: stops, patterns: patterns, trips: svcTrips, dates: outDates
    };
  }

  function weekday(yyyymmdd) { return new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8))).getUTCDay(); }
  // Deja solo los viajes de una línea y sentido que paran en una parada (la página es para una sola parada).
  function filterSchedule(sched, cfg) {
    var map = {}, patterns = [], trips = {}, dates = {}, stops = {}, routes = {};
    sched.patterns.forEach(function (p, i) {
      if (p[0] === cfg.route && p[1] === cfg.dir && p[3].indexOf(cfg.stop) >= 0) {
        map[i] = patterns.length; patterns.push(p);
        p[3].forEach(function (s) { if (sched.stops[s]) stops[s] = sched.stops[s]; });
      }
    });
    Object.keys(sched.trips).forEach(function (svc) {
      var t = sched.trips[svc].filter(function (tr) { return map[tr[0]] !== undefined; }).map(function (tr) { return [map[tr[0]], tr[1]]; });
      if (t.length) trips[svc] = t;
    });
    Object.keys(sched.dates).forEach(function (d) {
      var s = sched.dates[d].filter(function (x) { return trips[x]; });
      if (s.length) dates[d] = s;
    });
    if (sched.routes[cfg.route]) routes[cfg.route] = sched.routes[cfg.route];
    return { v: 1, feed: sched.feed, routes: routes, stops: stops, patterns: patterns, trips: trips, dates: dates };
  }

  function indexSchedule(sched) {
    var byKey = {}, byRD = {}, anyKey = {}, svcDays = {};
    Object.keys(sched.dates).forEach(function (d) {
      var wd = weekday(d);
      sched.dates[d].forEach(function (svc) { (svcDays[svc] = svcDays[svc] || [0, 0, 0, 0, 0, 0, 0])[wd]++; });
    });
    Object.keys(sched.trips).forEach(function (svc) {
      sched.trips[svc].forEach(function (tr) {
        var p = sched.patterns[tr[0]];
        byKey[svc + "|" + p[0] + "|" + p[1] + "|" + tr[1]] = tr[0];
        (byRD[svc + "|" + p[0] + "|" + p[1]] = byRD[svc + "|" + p[0] + "|" + p[1]] || []).push([tr[1], tr[0]]);
        var k = p[0] + "|" + p[1] + "|" + tr[1];
        (anyKey[k] = anyKey[k] || []).push([svc, tr[0]]);
      });
    });
    return { byKey: byKey, byRD: byRD, anyKey: anyKey, svcDays: svcDays };
  }

  // ---------- Protobuf mínimo para GTFS-Realtime ----------
  var S = {};
  function f(name, type, rep) { return [name, type, !!rep]; }
  S.FeedMessage = { 1: f("header", "FeedHeader"), 2: f("entity", "FeedEntity", 1) };
  S.FeedHeader = { 1: f("gtfs_realtime_version", "string"), 2: f("incrementality", "enum"), 3: f("timestamp", "uint") };
  S.FeedEntity = { 1: f("id", "string"), 2: f("is_deleted", "bool"), 3: f("trip_update", "TripUpdate"), 4: f("vehicle", "VehiclePosition"), 5: f("alert", "Alert") };
  S.TripUpdate = { 1: f("trip", "TripDescriptor"), 2: f("stop_time_update", "StopTimeUpdate", 1), 3: f("vehicle", "VehicleDescriptor"), 4: f("timestamp", "uint"), 5: f("delay", "int32") };
  S.StopTimeUpdate = { 1: f("stop_sequence", "uint"), 2: f("arrival", "StopTimeEvent"), 3: f("departure", "StopTimeEvent"), 4: f("stop_id", "string"), 5: f("schedule_relationship", "enum") };
  S.StopTimeEvent = { 1: f("delay", "int32"), 2: f("time", "int64"), 3: f("uncertainty", "int32") };
  S.TripDescriptor = { 1: f("trip_id", "string"), 2: f("start_time", "string"), 3: f("start_date", "string"), 4: f("schedule_relationship", "enum"), 5: f("route_id", "string"), 6: f("direction_id", "uint") };
  S.VehicleDescriptor = { 1: f("id", "string"), 2: f("label", "string"), 3: f("license_plate", "string") };
  S.VehiclePosition = { 1: f("trip", "TripDescriptor"), 2: f("position", "Position"), 3: f("current_stop_sequence", "uint"), 4: f("current_status", "enum"), 5: f("timestamp", "uint"), 6: f("congestion_level", "enum"), 7: f("stop_id", "string"), 8: f("vehicle", "VehicleDescriptor"), 9: f("occupancy_status", "enum") };
  S.Position = { 1: f("latitude", "float"), 2: f("longitude", "float"), 3: f("bearing", "float"), 4: f("odometer", "double"), 5: f("speed", "float") };
  S.Alert = { 1: f("active_period", "TimeRange", 1), 5: f("informed_entity", "EntitySelector", 1), 6: f("cause", "enum"), 7: f("effect", "enum"), 8: f("url", "TranslatedString"), 10: f("header_text", "TranslatedString"), 11: f("description_text", "TranslatedString") };
  S.TimeRange = { 1: f("start", "uint"), 2: f("end", "uint") };
  S.EntitySelector = { 1: f("agency_id", "string"), 2: f("route_id", "string"), 3: f("route_type", "int32"), 4: f("trip", "TripDescriptor"), 5: f("stop_id", "string"), 6: f("direction_id", "uint") };
  S.TranslatedString = { 1: f("translation", "Translation", 1) };
  S.Translation = { 1: f("text", "string"), 2: f("language", "string") };

  var utf8 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function decode(u8, start, end, schemaName) {
    var schema = S[schemaName], obj = {}, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), pos = start;
    function varint() {
      var r = 0n, shift = 0n, b;
      do {
        if (pos >= end) throw new Error("protobuf truncado");
        b = u8[pos++]; r |= BigInt(b & 0x7f) << shift; shift += 7n;
      } while (b & 0x80);
      return r;
    }
    while (pos < end) {
      var tag = Number(varint()), fno = tag >>> 3, wt = tag & 7, spec = schema[fno], val, raw;
      if (wt === 0) raw = varint();
      else if (wt === 1) { raw = pos; pos += 8; }
      else if (wt === 2) { var len = Number(varint()); raw = [pos, pos + len]; pos += len; }
      else if (wt === 5) { raw = pos; pos += 4; }
      else throw new Error("tipo de cable no soportado: " + wt);
      if (!spec) continue;
      var type = spec[1];
      if (type === "string") val = wt === 2 ? (utf8 ? utf8.decode(u8.subarray(raw[0], raw[1])) : Buffer.from(u8.subarray(raw[0], raw[1])).toString("utf8")) : undefined;
      else if (type === "uint" || type === "enum") val = Number(raw);
      else if (type === "bool") val = raw !== 0n;
      else if (type === "int32") val = Number(BigInt.asIntN(32, raw));
      else if (type === "int64") val = Number(BigInt.asIntN(64, raw));
      else if (type === "float") val = dv.getFloat32(raw, true);
      else if (type === "double") val = dv.getFloat64(raw, true);
      else val = decode(u8, raw[0], raw[1], type);
      if (val === undefined) continue;
      if (spec[2]) (obj[spec[0]] = obj[spec[0]] || []).push(val); else obj[spec[0]] = val;
    }
    return obj;
  }
  function decodeFeed(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return decode(u8, 0, u8.length, "FeedMessage");
  }

  // ---------- Fechas en Europe/Madrid ----------
  var dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function parts(ms) {
    var o = {};
    dtf.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function tzOffsetMs(ms) {
    var p = parts(ms);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }
  // Base GTFS del día de servicio: mediodía local menos 12 h (correcto también los días de cambio de hora).
  function serviceBaseMs(yyyymmdd) {
    var guess = Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8), 12);
    return guess - tzOffsetMs(guess) - 12 * 3600e3;
  }
  function localDate(ms) { var p = parts(ms); return p.year + p.month + p.day; }
  function addDays(yyyymmdd, n) {
    var d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  }

  // ---------- Llegadas a una parada ----------
  function dist(a, b) { // metros, equirectangular
    var k = Math.PI / 180, x = (b[1] - a[1]) * k * Math.cos((a[0] + b[0]) / 2 * k), y = (b[0] - a[0]) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  function project(p, a, b) { // distancia al segmento a-b y fracción recorrida
    var k = Math.PI / 180, c = Math.cos(a[0] * k);
    var ax = a[1] * c, ay = a[0], bx = b[1] * c, by = b[0], px = p[1] * c, py = p[0];
    var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return { d: dist(p, [ay + t * dy, (ax + t * dx) / c]), t: t };
  }

  // Fecha que el GTFS no cubre: el servicio que más circula ese día de la semana (laborable, miércoles, sábado, domingo).
  function svcScore(idx, svc, wd) {
    var days = idx.svcDays[svc] || [0, 0, 0, 0, 0, 0, 0], cls = function (d) { return d === 0 ? 0 : d === 6 ? 6 : 1; }, sc = 10 * days[wd];
    for (var k = 0; k < 7; k++) if (cls(k) === cls(wd)) sc += days[k];
    return sc;
  }
  function guessServices(idx, date) {
    var wd = weekday(date), best = null, bestScore = 0;
    Object.keys(idx.svcDays).forEach(function (svc) { var sc = svcScore(idx, svc, wd); if (sc > bestScore) { best = svc; bestScore = sc; } });
    return best ? [best] : [];
  }

  function seqsOf(p) { return p[5] || p[3].map(function (_, i) { return i + 1; }); }
  // ¿Encajan las paradas del TripUpdate con este patrón? (descarta el sentido o el viaje equivocado)
  function patternFits(p, stus) {
    var ids = p[3], seqs = seqsOf(p);
    for (var k = 0; k < stus.length; k++) {
      var s = stus[k];
      if (s.stop_id == null) continue;
      if (s.stop_sequence != null) { if (ids[seqs.indexOf(s.stop_sequence)] !== s.stop_id) return false; }
      else if (ids.indexOf(s.stop_id) < 0) return false;
    }
    return true;
  }

  function startOf(td) {
    var t0 = hms(td.start_time);
    if (t0 == null) { var mm = /_(\d{1,2}):(\d{2})_/.exec(td.trip_id || ""); if (mm) t0 = (+mm[1]) * 3600 + (+mm[2]) * 60; }
    return t0;
  }
  // Fecha sin cubrir: elige el servicio cuyos horarios casan con más viajes en directo (p. ej. un festivo entre semana).
  function voteServices(sched, idx, feeds, cfg, today) {
    var byDate = {}, out = {};
    ((feeds.tu && feeds.tu.entity) || []).forEach(function (e) {
      var u = e.trip_update; if (!u || e.is_deleted) return;
      var td = u.trip || {}, t0 = startOf(td);
      if (t0 == null || (td.route_id != null && td.route_id !== cfg.route) || td.schedule_relationship === 1) return;
      var date = td.start_date || (t0 >= 86400 ? addDays(today, -1) : today);
      if (sched.dates[date]) return;
      (byDate[date] = byDate[date] || []).push(t0);
    });
    Object.keys(byDate).forEach(function (date) {
      var wd = weekday(date), best = null, bestScore = -1;
      Object.keys(idx.svcDays).forEach(function (svc) {
        var list = idx.byRD[svc + "|" + cfg.route + "|" + cfg.dir] || [], hits = 0;
        byDate[date].forEach(function (t0) { if (list.some(function (c) { return Math.abs(c[0] - t0) <= 120; })) hits++; });
        var sc = hits * 1000 + svcScore(idx, svc, wd);
        if (hits && sc > bestScore) { best = svc; bestScore = sc; }
      });
      if (best) out[date] = best;
    });
    return out;
  }

  function matchTrip(sched, idx, td, fallbackDate, stus, forced) {
    var t0 = startOf(td);
    var route = td.route_id;
    if (route == null) { var r = /^L(\w+?)_/.exec(td.trip_id || ""); if (r) route = r[1]; }
    if (t0 == null || route == null) return null;
    var date = td.start_date || (t0 >= 86400 ? addDays(fallbackDate, -1) : fallbackDate);
    var dirs = td.direction_id != null ? [td.direction_id] : [0, 1], svcs = sched.dates[date] || (forced && forced[date] ? [forced[date]] : null), cands = [];
    if (svcs) {
      // Fecha cubierta por el GTFS: mismo servicio, línea y sentido; hora de salida exacta o a ±2 min.
      dirs.forEach(function (dir) {
        svcs.forEach(function (svc) {
          (idx.byRD[svc + "|" + route + "|" + dir] || []).forEach(function (c) {
            var dt = Math.abs(c[0] - t0);
            if (dt <= 120) cands.push({ pi: c[1], t0: c[0], dt: dt, score: 0 });
          });
        });
      });
    } else {
      // Fecha no cubierta: el viaje equivalente del servicio que más circula ese día de la semana.
      var wd = weekday(date);
      dirs.forEach(function (dir) {
        (idx.anyKey[route + "|" + dir + "|" + t0] || []).forEach(function (c) { cands.push({ pi: c[1], t0: t0, dt: 0, score: svcScore(idx, c[0], wd) }); });
      });
    }
    cands = cands.filter(function (c) { return patternFits(sched.patterns[c.pi], stus || []); });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return a.dt - b.dt || b.score - a.score; });
    return { pi: cands[0].pi, t0: cands[0].t0, date: date, exact: !!sched.dates[date] };
  }

  // Paradas anuladas por avisos activos de la línea (p. ej. obras): no cuentan al decir cuántas faltan.
  function cancelledStops(sched, feeds, cfg, nowMs) {
    var out = {}, short = String((sched.routes[cfg.route] || [cfg.route])[0]).toUpperCase();
    ((feeds.al && feeds.al.entity) || []).forEach(function (e) {
      var a = e.alert; if (!a || e.is_deleted) return;
      var active = !a.active_period || a.active_period.some(function (r) { return (!r.start || r.start * 1000 <= nowMs) && (!r.end || r.end * 1000 >= nowMs); });
      if (!active || [1, 4, 6, 9].indexOf(a.effect) < 0) return; // sin servicio, desvío, servicio modificado, parada trasladada
      var head = a.header_text && a.header_text.translation && a.header_text.translation[0] ? a.header_text.translation[0].text : "";
      var m = /L[ÍI]NEA\s+([0-9A-Z]+)\b/i.exec(head || "");
      var mine = (m && m[1].toUpperCase() === short) || (a.informed_entity || []).some(function (ie) { return ie.route_id === cfg.route; });
      if (!mine) return;
      (a.informed_entity || []).forEach(function (ie) { if (ie.stop_id && ie.stop_id !== cfg.stop) out[ie.stop_id] = 1; });
    });
    return out;
  }

  function stopsUntil(ids, fromIdx, fromStopId, ti, skip) {
    var n = 0, prev = fromStopId;
    for (var k = fromIdx + 1; k <= ti; k++) {
      if (skip[ids[k]] || ids[k] === prev) continue;
      n++; prev = ids[k];
    }
    return n;
  }

  // cfg: {route, dir, stop}; feeds: {tu, vp, al} decodificados; devuelve llegadas ordenadas.
  function computeArrivals(sched, idx, feeds, cfg, nowMs) {
    var today = localDate(nowMs), out = [], seen = {};
    var skip = cancelledStops(sched, feeds, cfg, nowMs), tgt = sched.stops[cfg.stop];
    var forced = voteServices(sched, idx, feeds, cfg, today), tuTs = feeds.tu && feeds.tu.header && feeds.tu.header.timestamp;
    var vpByTrip = {}, vpByVeh = {};
    ((feeds.vp && feeds.vp.entity) || []).forEach(function (e) {
      var v = e.vehicle; if (!v || e.is_deleted) return;
      if (v.trip && v.trip.trip_id) vpByTrip[v.trip.trip_id + "|" + (v.trip.start_date || "")] = v;
      if (v.vehicle && v.vehicle.id) vpByVeh[v.vehicle.id] = v;
    });
    function vpFor(td, u) {
      var v = vpByTrip[(td.trip_id || "") + "|" + (td.start_date || "")] || vpByTrip[(td.trip_id || "") + "|"];
      // Por vehículo solo si la posición no dice qué viaje hace (si no, puede ser el viaje anterior de ese bus).
      if (!v && u.vehicle && vpByVeh[u.vehicle.id] && !(vpByVeh[u.vehicle.id].trip && vpByVeh[u.vehicle.id].trip.trip_id)) v = vpByVeh[u.vehicle.id];
      // Solo posiciones recientes (menos de 3 min).
      if (!v || !v.position || !v.position.latitude || (v.timestamp && v.timestamp * 1000 < nowMs - 180e3)) return null;
      return v;
    }
    function ev(s, preferDep) {
      var a = s.arrival, d = s.departure, has = function (x) { return x && (x.delay != null || x.time != null); };
      return preferDep ? (has(d) ? d : has(a) ? a : null) : (has(a) ? a : has(d) ? d : null);
    }

    ((feeds.tu && feeds.tu.entity) || []).forEach(function (e) {
      var u = e.trip_update; if (!u || e.is_deleted) return;
      var td = u.trip || {}, raw = u.stop_time_update || [];
      if (td.route_id != null && td.route_id !== cfg.route) return;
      if (td.direction_id != null && td.direction_id !== cfg.dir) return;
      var m = td.schedule_relationship === 1 ? null : matchTrip(sched, idx, td, today, raw, forced);
      if (!m) {
        // Viaje añadido (refuerzo) o que no está en el horario: solo si trae hora absoluta en tu parada.
        if (td.route_id !== cfg.route && !(td.trip_id || "").match(new RegExp("^L" + cfg.route + "_"))) return;
        raw.forEach(function (s) {
          if (s.stop_id !== cfg.stop || s.schedule_relationship === 1) return;
          var x = ev(s, false);
          if (x && x.time != null) out.push({ key: "added|" + td.trip_id, trip: td.trip_id, schedMs: x.time * 1000, predMs: x.time * 1000, added: true, source: "rt", exact: true });
        });
        return;
      }
      var p = sched.patterns[m.pi];
      if (p[0] !== cfg.route || p[1] !== cfg.dir) return;
      var key = m.date + "|" + m.t0;
      seen[key] = 1;
      var ids = p[3], offs = p[4], seqs = seqsOf(p);
      // Normaliza las actualizaciones: secuencia (o la deduce por stop_id) y orden.
      var last = -1, stus = [];
      raw.forEach(function (s) {
        var seq = s.stop_sequence;
        if (seq == null && s.stop_id != null) {
          for (var i = last + 1; i < ids.length; i++) if (ids[i] === s.stop_id) { seq = seqs[i]; break; }
        }
        if (seq == null) return;
        last = seqs.indexOf(seq);
        stus.push({ seq: seq, s: s });
      });
      stus.sort(function (a, b) { return a.seq - b.seq; });
      var firstSeq = stus.length ? stus[0].seq : null;
      var fi = firstSeq != null ? Math.max(0, seqs.indexOf(firstSeq)) : 0;
      var base = serviceBaseMs(m.date), v = vpFor(td, u);
      var ti = -1;
      for (var i = 0; i < ids.length; i++) if (ids[i] === cfg.stop && (firstSeq == null || seqs[i] >= firstSeq)) { ti = i; break; }
      if (ti < 0) {
        // El TripUpdate ya quitó tu parada, pero el GPS dice que el bus está ahí mismo: sigue siendo «Llegando».
        var li = -1;
        for (i = 0; i < fi; i++) if (ids[i] === cfg.stop) li = i;
        var uTs = u.timestamp || tuTs;
        if (li >= 0 && li === fi - 1 && v && tgt && (!v.timestamp || !uTs || v.timestamp >= uTs - 30) &&
            dist([v.position.latitude, v.position.longitude], [tgt[1], tgt[2]]) < 50) {
          out.push({ key: key, trip: td.trip_id, schedMs: base + (m.t0 + offs[li]) * 1000, predMs: nowMs, source: "rt", exact: m.exact,
            pos: { ms: nowMs, ahead: false, stopsLeft: 0, near: tgt[0], atStop: true, arriving: true } });
        }
        return;
      }
      var schedMs = base + (m.t0 + offs[ti]) * 1000;
      if (td.schedule_relationship === 3) { out.push({ key: key, trip: td.trip_id, schedMs: schedMs, predMs: null, canceled: true, source: "rt", exact: m.exact }); return; }

      var predMs = null, skipped = false, at = null, prevs = [];
      for (i = 0; i < stus.length; i++) { if (stus[i].seq === seqs[ti]) at = stus[i].s; else if (stus[i].seq < seqs[ti]) prevs.push(stus[i]); }
      if (at && at.schedule_relationship === 1) skipped = true;
      var atScheduled = !!at && (at.schedule_relationship == null || at.schedule_relationship === 0);
      var x = atScheduled ? ev(at, false) : null;
      if (x) predMs = x.time != null ? x.time * 1000 : schedMs + x.delay * 1000;
      else if (!at || at.schedule_relationship !== 2) {
        // Propagación GTFS-RT: retraso de la última parada anterior con datos (las SKIPPED no cuentan; NO_DATA corta).
        for (i = prevs.length - 1; i >= 0; i--) {
          var ps = prevs[i].s;
          if (ps.schedule_relationship === 1) continue;
          if (ps.schedule_relationship === 2) break;
          var y = ev(ps, true);
          if (!y) continue;
          var d = y.delay;
          if (d == null) d = y.time - (base / 1000 + m.t0 + offs[seqs.indexOf(prevs[i].seq)]);
          predMs = schedMs + d * 1000;
          break;
        }
        if (predMs == null && !prevs.length && !at && u.delay != null) predMs = schedMs + u.delay * 1000;
      }

      // Posición GPS: dónde va y estimación propia según el horario desde su posición.
      var pos = null;
      if (v) {
        var P = [v.position.latitude, v.position.longitude], best = null, first = null;
        for (i = Math.max(0, fi - 1); i <= ti && i + 1 < ids.length; i++) {
          var a = sched.stops[ids[i]], b = sched.stops[ids[i + 1]];
          if (!a || !b) continue;
          var pr = project(P, [a[1], a[2]], [b[1], b[2]]), c = { d: pr.d, i: i, t: pr.t };
          if (!first && pr.d <= 60) first = c;
          if (!best || pr.d < best.d) best = c;
        }
        best = first || best;
        if (best && best.d <= 150) {
          var tgtDist = tgt ? dist(P, [tgt[1], tgt[2]]) : 1e9;
          if (best.i === ti && best.t > 0 && tgtDist > 60 && best.d <= 40) return; // el GPS dice que ya ha pasado tu parada
          if (best.i === ti) best = ti > 0 ? { d: best.d, i: ti - 1, t: 1 } : { d: best.d, i: 0, t: 0 };
          var here = best.i, nearIdx = best.t > 0.5 ? here + 1 : here;
          var nearStop = sched.stops[ids[nearIdx]];
          var atStop = !!nearStop && dist(P, [nearStop[1], nearStop[2]]) < 50;
          var schedHere = offs[here] + best.t * ((offs[here + 1] != null ? offs[here + 1] : offs[here]) - offs[here]);
          var posMs = (v.timestamp ? v.timestamp * 1000 : nowMs) + (offs[ti] - schedHere) * 1000;
          var left = atStop ? stopsUntil(ids, nearIdx, ids[nearIdx], ti, skip) : nearIdx === ti ? 0 : stopsUntil(ids, here, ids[here], ti, skip);
          pos = {
            ms: posMs,
            // Solo si el GPS lo sitúa más allá de lo que cree la predicción y además da una hora anterior.
            ahead: firstSeq != null && (here > fi || (here === fi && best.t > 0.5)) && predMs != null && posMs < predMs - 60e3,
            stopsLeft: left,
            near: nearStop ? nearStop[0] : "",
            atStop: atStop,
            arriving: left === 0
          };
        }
      }
      out.push({
        key: key, trip: td.trip_id, vehicle: (u.vehicle && u.vehicle.id) || (v && v.vehicle && v.vehicle.id) || "",
        schedMs: schedMs, predMs: predMs, pos: pos, skipped: skipped, source: "rt", exact: m.exact, headsign: p[2]
      });
    });
    // Viajes del horario sin datos en tiempo real (los próximos 3 h).
    [addDays(today, -1), today].forEach(function (date) {
      var base = serviceBaseMs(date), svcs = sched.dates[date], approx = false;
      if (!svcs) { svcs = forced[date] ? [forced[date]] : guessServices(idx, date); approx = true; }
      svcs.forEach(function (svc) {
        (sched.trips[svc] || []).forEach(function (tr) {
          var p = sched.patterns[tr[0]];
          if (p[0] !== cfg.route || p[1] !== cfg.dir || seen[date + "|" + tr[1]]) return;
          var ti = p[3].indexOf(cfg.stop);
          if (ti < 0) return;
          var ms = base + (tr[1] + p[4][ti]) * 1000;
          if (ms < nowMs - 60e3 || ms > nowMs + 3 * 3600e3) return;
          seen[date + "|" + tr[1]] = 1;
          out.push({ key: date + "|" + tr[1], schedMs: ms, predMs: null, source: "sched", started: base + tr[1] * 1000 <= nowMs, headsign: p[2], exact: !approx });
        });
      });
    });
    out.forEach(function (a) { a.etaMs = a.canceled ? null : (a.predMs != null ? a.predMs : a.schedMs); });
    return out
      .filter(function (a) { return a.canceled ? a.schedMs > nowMs - 60e3 : a.etaMs > nowMs - 60e3; })
      .sort(function (a, b) { return (a.etaMs != null ? a.etaMs : a.schedMs) - (b.etaMs != null ? b.etaMs : b.schedMs); });
  }

  function alertsFor(sched, feeds, cfg, nowMs) {
    var stopSet = {};
    stopSet[cfg.stop] = 1;
    var tr = function (ts) { return ts && ts.translation && ts.translation.length ? (ts.translation.filter(function (t) { return /^es/i.test(t.language || "es"); })[0] || ts.translation[0]).text : ""; };
    return ((feeds.al && feeds.al.entity) || []).filter(function (e) { return !e.is_deleted; }).map(function (e) { return e.alert; }).filter(function (a) {
      if (!a) return false;
      var active = !a.active_period || a.active_period.some(function (r) { return (!r.start || r.start * 1000 <= nowMs) && (!r.end || r.end * 1000 >= nowMs); });
      // Solo avisos de tu parada, o de tu línea entera (sin paradas concretas).
      var hits = (a.informed_entity || []).some(function (ie) { return (ie.stop_id && stopSet[ie.stop_id]) || (!ie.stop_id && (ie.route_id === cfg.route || (ie.trip && ie.trip.route_id === cfg.route))); });
      return active && hits;
    }).map(function (a) { return { header: tr(a.header_text), text: tr(a.description_text) }; }).filter(function (a) {
      // Avisos que solo nombran paradas compartidas: descarta los que dicen ser de otra línea («LÍNEA 3 - ...»).
      var m = /L[ÍI]NEA\s+([0-9A-Z]+)\b/i.exec(a.header);
      var short = (sched.routes[cfg.route] || [cfg.route])[0];
      return !m || m[1].toUpperCase() === String(short).toUpperCase() || m[1].toUpperCase() === String(cfg.route).toUpperCase();
    });
  }

  return {
    TZ: TZ, parseCSV: parseCSV, hms: hms, deriveSchedule: deriveSchedule, filterSchedule: filterSchedule, indexSchedule: indexSchedule,
    decodeFeed: decodeFeed, serviceBaseMs: serviceBaseMs, localDate: localDate, addDays: addDays,
    computeArrivals: computeArrivals, alertsFor: alertsFor, matchTrip: matchTrip
  };
})();
if (typeof module !== "undefined") module.exports = BusCore;
