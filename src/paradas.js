(function () {
  "use strict";
  var C = BusCore;
  var UID = "c-5cfcd2d1";
  var FEEDS = {
    tu: "https://api.control.optibus.co/opendata/v1/gtfs-rt/trip-updates?uid=" + UID,
    vp: "https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=" + UID,
    al: "https://api.control.optibus.co/opendata/v1/gtfs-rt/alerts?uid=" + UID
  };
  var REFRESH_MS = 30000;

  // Parámetros de prueba: ?src=local lee tu.pb/vp.pb/al.pb junto al HTML; ?now=<ms> fija el reloj.
  var qs = new URLSearchParams(location.search);
  if (qs.get("src") === "local") FEEDS = { tu: "tu.pb", vp: "vp.pb", al: "al.pb" };
  var clockOffset = qs.get("now") ? +qs.get("now") - Date.now() : 0;
  function now() { return Date.now() + clockOffset; }

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
  };

  var sched = window.BUS_SCHEDULE, idx = C.indexSchedule(sched);
  var state = { feeds: null, fetchedAt: null, error: null, loading: false, loadingSince: 0, stop: null, query: "" };
  var geo = { pos: null, acc: null, error: null, busy: false };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- Paradas y líneas ----------
  // Líneas (línea + sentido) en las que se puede subir en cada parada: no cuenta la parada final del recorrido.
  var combos = {};
  sched.patterns.forEach(function (p) {
    var ids = p[3];
    ids.forEach(function (s, i) {
      if (i === ids.length - 1 && ids[0] !== s) return;
      var k = p[0] + "|" + p[1];
      (combos[s] = combos[s] || {})[k] = { route: p[0], dir: p[1] };
    });
  });
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
  var stops = Object.keys(sched.stops).filter(function (id) { return combos[id]; }).map(function (id) {
    var s = sched.stops[id];
    return { id: id, name: s[0], lat: s[1], lon: s[2], n: norm(s[0]) };
  });
  var byId = {};
  stops.forEach(function (s) { byId[s.id] = s; });
  function routesAt(id) {
    var r = {};
    Object.keys(combos[id] || {}).forEach(function (k) { r[combos[id][k].route] = 1; });
    return Object.keys(r).sort(function (a, b) { return (parseFloat(a) || 999) - (parseFloat(b) || 999); });
  }

  // ---------- Formato ----------
  var fmtHM = new Intl.DateTimeFormat("es-ES", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit" });
  var fmtHMS = new Intl.DateTimeFormat("es-ES", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function hm(ms) { return fmtHM.format(new Date(ms)); }
  function hmsTxt(ms) { return fmtHMS.format(new Date(ms)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function title(s) {
    var small = { de: 1, del: 1, la: 1, las: 1, el: 1, los: 1, y: 1 };
    return String(s || "").toLowerCase().split(/(\s+|-)/).map(function (w, i) {
      return i > 0 && small[w] ? w : w.charAt(0).toUpperCase() + w.slice(1);
    }).join("");
  }
  function minsLeft(ms) {
    var diff = ms - now();
    if (diff <= 30e3) return null;
    return Math.max(1, Math.floor(ms / 60000) - Math.floor(now() / 60000));
  }
  function distTxt(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km"; }
  function dist(a, b) {
    var k = Math.PI / 180, x = (b[1] - a[1]) * k * Math.cos((a[0] + b[0]) / 2 * k), y = (b[0] - a[0]) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  function lum(hex) {
    var c = [0, 2, 4].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // Distintivo de línea con su color de EMTF y el texto (blanco o negro) que más contraste da.
  function badge(route) {
    var r = sched.routes[route] || [route, "", ""];
    var bg = /^[0-9a-f]{6}$/i.test(r[2] || "") ? r[2] : "135FCB", L = lum(bg);
    var fg = (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#101a2b" : "#ffffff";
    return '<span class="badge" style="background:#' + bg + ";color:" + fg + '">' + esc(r[0]) + "</span>";
  }

  // ---------- Llegadas ----------
  function arrivalsAt(stopId, t) {
    var out = [];
    Object.keys(combos[stopId] || {}).forEach(function (k) {
      var c = combos[stopId][k];
      C.computeArrivals(sched, idx, state.feeds || {}, { route: c.route, dir: c.dir, stop: stopId, boardingOnly: true }, t).forEach(function (a) {
        a.route = c.route; out.push(a);
      });
    });
    return out.sort(function (a, b) { return (a.etaMs != null ? a.etaMs : a.schedMs) - (b.etaMs != null ? b.etaMs : b.schedMs); });
  }
  function alertsAt(stopId, t) {
    if (!state.feeds) return [];
    var seen = {}, out = [];
    routesAt(stopId).forEach(function (r) {
      C.alertsFor(sched, state.feeds, { route: r, dir: 0, stop: stopId }, t).forEach(function (a) {
        if (!seen[a.header + a.text]) { seen[a.header + a.text] = 1; out.push(a); }
      });
    });
    return out;
  }
  function statusOf(a) {
    if (a.canceled) return { cls: "bad", txt: "Cancelado" };
    if (a.skipped) return { cls: "bad", txt: "No para aquí" };
    if (a.added) return { cls: "ok", txt: "Refuerzo" };
    if (a.source === "sched") return { cls: "muted", txt: "Según horario" };
    if (a.predMs == null) return { cls: "muted", txt: "Sin predicción" };
    var d = Math.round((a.predMs - a.schedMs) / 60000);
    if (d === 0) return { cls: "ok", txt: "En hora" };
    return d < 0 ? { cls: "ok", txt: -d + " min adelantado" } : { cls: "late", txt: d + " min de retraso" };
  }
  function rowHtml(a) {
    var s = statusOf(a), dead = a.canceled || a.skipped;
    var here = a.pos && a.pos.stopsLeft === 0 && a.pos.atStop;
    var m = dead ? null : here ? null : minsLeft(a.etaMs);
    var big = dead ? "—" : m == null ? (a.source === "sched" ? "Ahora" : "Llegando") : m + " min";
    var where = "";
    if (a.pos && !dead) where = a.pos.stopsLeft === 0 ? (a.pos.atStop ? "En la parada" : "Llegando a la parada") : (a.pos.stopsLeft === 1 ? "a 1 parada" : "a " + a.pos.stopsLeft + " paradas");
    return '<li class="row' + (dead ? " dead" : "") + '">' + badge(a.route) +
      '<span class="row-main"><span class="row-dest">' + esc(title(a.headsign || "")) + "</span>" +
      '<span class="row-sub">' + (dead ? hm(a.schedMs) : hm(a.etaMs)) + ' · <span class="st ' + s.cls + '">' + esc(s.txt) + "</span>" + (where ? " · " + where : "") + "</span></span>" +
      '<span class="row-min' + (m == null && !dead ? " now" : "") + '">' + big + "</span></li>";
  }

  // ---------- Pintado ----------
  function renderStop(t) {
    var box = $("stop");
    if (!state.stop || !byId[state.stop]) { box.hidden = true; return; }
    var s = byId[state.stop], list = arrivalsAt(s.id, t).slice(0, 8), al = alertsAt(s.id, t);
    box.hidden = false;
    $("stop-name").textContent = s.name;
    $("stop-code").textContent = s.id;
    $("stop-lines").innerHTML = routesAt(s.id).map(badge).join("");
    $("stop-list").innerHTML = list.length ? list.map(rowHtml).join("")
      : '<li class="none">' + (state.feeds || state.error ? "No pasa ningún bus en las próximas 3 horas." : "Cargando…") + "</li>";
    $("stop-alerts").innerHTML = al.map(function (x) {
      return '<div class="alert"><p class="alert-h">' + esc(x.header) + "</p>" + (x.text ? '<p class="alert-t">' + esc(x.text) + "</p>" : "") + "</div>";
    }).join("");
    document.title = s.name + " · Paradas EMTF";
  }
  function renderNear(t) {
    var box = $("near-list"), msg = $("near-msg"), btn = $("btn-locate");
    btn.textContent = geo.pos ? "Actualizar ubicación" : "Usar mi ubicación";
    btn.disabled = geo.busy;
    if (geo.busy && !geo.pos) { msg.textContent = "Buscando tu ubicación…"; msg.hidden = false; }
    else if (geo.error) { msg.textContent = geo.error; msg.hidden = false; }
    else if (!geo.pos) { msg.textContent = "Activa la ubicación para ver las 3 paradas más cercanas."; msg.hidden = false; }
    else msg.hidden = true;
    if (!geo.pos) { box.innerHTML = ""; return; }
    var near = stops.map(function (s) { return { s: s, d: dist(geo.pos, [s.lat, s.lon]) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
    box.innerHTML = near.map(function (n) {
      var list = arrivalsAt(n.s.id, t).filter(function (a) { return !a.canceled && !a.skipped; }).slice(0, 3);
      return '<li><button type="button" class="near" data-stop="' + esc(n.s.id) + '">' +
        '<span class="near-head"><span class="near-name">' + esc(n.s.name) + '</span><span class="near-dist">' + distTxt(n.d) + "</span></span>" +
        '<span class="near-meta">Parada <b>' + esc(n.s.id) + "</b> " + routesAt(n.s.id).map(badge).join("") + "</span>" +
        '<ul class="rows">' + (list.length ? list.map(rowHtml).join("") : '<li class="none">' + (state.feeds || state.error ? "Sin buses en las próximas 3 horas" : "Cargando…") + "</li>") + "</ul>" +
        "</button></li>";
    }).join("");
  }
  function renderStatus(t) {
    var parts = [];
    if (state.loading) parts.push("Actualizando…");
    var ts = state.feeds && state.feeds.tu && state.feeds.tu.header && state.feeds.tu.header.timestamp;
    if (ts) {
      var age = Math.round((t - ts * 1000) / 1000);
      parts.push("Datos de las " + hmsTxt(ts * 1000) + (age > 180 ? ' <span class="stale">(' + (age < 3600 ? "hace " + Math.round(age / 60) + " min" : "hace más de una hora") + ")</span>" : ""));
    } else if (state.feeds && state.fetchedAt) parts.push("Datos recibidos a las " + hmsTxt(state.fetchedAt + clockOffset));
    $("status").innerHTML = parts.join(" · ") || (state.error ? "Sin datos en directo" : "Descargando datos en directo…");
    $("error").hidden = !state.error;
    if (state.error) {
      var e = state.error;
      $("error").textContent = (e && e.name === "AbortError" ? "El servidor de datos en directo no responde."
        : /servidor respondió|respuesta vacía|protobuf|cable/.test(String(e && e.message)) ? "El servidor de EMT no está dando datos en directo ahora mismo."
        : "No he podido descargar los datos en directo. Comprueba la conexión.") + (state.feeds ? " Muestro los últimos que tengo." : " Mientras tanto ves el horario.");
    }
  }
  function render() { var t = now(); renderStop(t); renderNear(t); renderStatus(t); }

  // ---------- Buscador ----------
  function search(q) {
    var n = norm(q);
    if (!n) return [];
    if (/^\d+$/.test(n)) {
      return stops.filter(function (s) { return s.id.indexOf(n) === 0; })
        .sort(function (a, b) { return (a.id === n ? -1 : 0) - (b.id === n ? -1 : 0) || a.id.length - b.id.length || a.id.localeCompare(b.id); });
    }
    var words = n.split(" ");
    return stops.filter(function (s) { return words.every(function (w) { return s.n.indexOf(w) >= 0; }); })
      .sort(function (a, b) { return a.n.indexOf(words[0]) - b.n.indexOf(words[0]) || a.name.localeCompare(b.name); });
  }
  function renderSuggest() {
    var q = $("q").value, res = search(q).slice(0, 8), box = $("suggest");
    if (!q.trim()) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = res.length ? res.map(function (s) {
      return '<li><button type="button" class="sug" data-stop="' + esc(s.id) + '"><b>' + esc(s.id) + "</b> " + esc(s.name) +
        ' <span class="sug-lines">' + routesAt(s.id).map(badge).join("") + "</span></button></li>";
    }).join("") : '<li class="none">No hay ninguna parada con «' + esc(q.trim()) + "».</li>";
  }
  function selectStop(id, fromHash) {
    if (!byId[id]) return;
    state.stop = id;
    store.set("paradas.last", id);
    if (!fromHash && location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    $("q").value = ""; renderSuggest();
    render();
    $("stop").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Ubicación ----------
  function locate() {
    if (!navigator.geolocation) { geo.error = "Este navegador no da la ubicación."; render(); return; }
    geo.busy = true; geo.error = null; render();
    navigator.geolocation.getCurrentPosition(function (p) {
      geo.busy = false; geo.pos = [p.coords.latitude, p.coords.longitude]; geo.acc = p.coords.accuracy;
      store.set("paradas.geo", "1"); render();
    }, function (e) {
      geo.busy = false;
      geo.error = e.code === 1 ? "No tengo permiso para ver tu ubicación. En el iPhone: Ajustes → Privacidad → Localización → Safari → «Mientras se usa la app»."
        : "No he podido saber dónde estás. Prueba otra vez.";
      render();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  // ---------- Descarga ----------
  function getFeed(url) {
    var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { ac.abort(); }, 15000) : null;
    return fetch(url, ac ? { cache: "no-store", signal: ac.signal } : { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("el servidor respondió " + r.status);
      return r.arrayBuffer();
    }).then(function (b) {
      var feed = C.decodeFeed(new Uint8Array(b));
      if (!feed.header) throw new Error("respuesta vacía");
      return feed;
    }).then(function (f) { clearTimeout(timer); return f; }, function (e) { clearTimeout(timer); throw e; });
  }
  function refresh() {
    if (state.loading && Date.now() - state.loadingSince < 20000) return;
    state.loading = true; state.loadingSince = Date.now(); renderStatus(now());
    Promise.all([getFeed(FEEDS.tu), getFeed(FEEDS.vp).catch(function () { return null; }), getFeed(FEEDS.al).catch(function () { return null; })])
      .then(function (r) { state.feeds = { tu: r[0], vp: r[1], al: r[2] }; state.fetchedAt = Date.now(); state.error = null; })
      .catch(function (e) { state.error = e; })
      .then(function () { state.loading = false; render(); });
  }

  // ---------- Eventos ----------
  $("q").addEventListener("input", renderSuggest);
  $("search").addEventListener("submit", function (e) {
    e.preventDefault();
    var res = search($("q").value);
    if (res.length) selectStop(res[0].id);
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-stop]");
    if (b) selectStop(b.getAttribute("data-stop"));
  });
  $("btn-locate").addEventListener("click", locate);
  $("btn-refresh").addEventListener("click", function () { refresh(); if (geo.pos) locate(); });
  $("btn-close").addEventListener("click", function () {
    state.stop = null; history.replaceState(null, "", location.pathname + location.search); document.title = "Paradas EMTF"; render();
  });
  window.addEventListener("hashchange", function () { var h = location.hash.slice(1); if (byId[h]) selectStop(h, true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && (!state.fetchedAt || Date.now() - state.fetchedAt > 10e3)) { refresh(); if (geo.pos) locate(); }
  });

  // Arranque: parada del enlace (#15956) y ubicación si ya diste permiso.
  var h = location.hash.slice(1);
  if (byId[h]) { state.stop = h; }
  render();
  refresh();
  if (store.get("paradas.geo") === "1") locate();
  else if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then(function (p) { if (p.state === "granted") locate(); }, function () { /* sin API de permisos */ });
  }
  setInterval(function () { if (document.visibilityState !== "hidden") { refresh(); if (geo.pos) locate(); } }, REFRESH_MS);
  setInterval(render, 1000);
})();
