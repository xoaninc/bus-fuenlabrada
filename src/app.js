(function () {
  "use strict";
  var C = BusCore;
  var CFG = { route: "4", dir: 0, stop: "15956" }; // L4 → Loranca, parada 15956
  var UID = "c-5cfcd2d1";
  var FEEDS = {
    tu: "https://api.control.optibus.co/opendata/v1/gtfs-rt/trip-updates?uid=" + UID,
    vp: "https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=" + UID,
    al: "https://api.control.optibus.co/opendata/v1/gtfs-rt/alerts?uid=" + UID
  };
  var NAP_URL = "https://nap.transportes.gob.es/ConjuntoDato/Detail/1628";
  var JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  var REFRESH_MS = 30000;

  // Parámetros de prueba: ?src=local lee tu.pb/vp.pb/al.pb junto al HTML; ?now=<ms> fija el reloj.
  var qs = new URLSearchParams(location.search);
  if (qs.get("src") === "local") FEEDS = { tu: "tu.pb", vp: "vp.pb", al: "al.pb" };
  var clockOffset = qs.get("now") ? +qs.get("now") - Date.now() : 0;
  function now() { return Date.now() + clockOffset; }

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  };

  // Horario: el incluido en la página o uno más nuevo que hayas cargado.
  var EMBEDDED = window.BUS_SCHEDULE;
  function validSched(x) {
    return !!(x && x.v === 1 && x.feed && typeof x.feed.end === "string" && Array.isArray(x.patterns) && x.patterns.length &&
      x.trips && typeof x.trips === "object" && x.dates && typeof x.dates === "object" && x.stops && typeof x.stops === "object");
  }
  var sched = EMBEDDED, idx = C.indexSchedule(EMBEDDED);
  try {
    var st = JSON.parse(store.get("bus.sched") || "null");
    if (validSched(st) && st.feed.end > EMBEDDED.feed.end) { var stIdx = C.indexSchedule(st); sched = st; idx = stIdx; }
  } catch (e) { /* horario guardado inservible: se usa el incluido */ }

  var state = { feeds: null, fetchedAt: null, error: null, loading: false, loadingSince: 0, gtfsMsg: "" };
  var $ = function (id) { return document.getElementById(id); };

  var fmtHM = new Intl.DateTimeFormat("es-ES", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit" });
  var fmtHMS = new Intl.DateTimeFormat("es-ES", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function hm(ms) { return fmtHM.format(new Date(ms)); }
  function hmsTxt(ms) { return fmtHMS.format(new Date(ms)); }
  function ymdTxt(d) { return d ? d.slice(6, 8) + "/" + d.slice(4, 6) + "/" + d.slice(0, 4) : "?"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function minsLeft(ms) {
    var diff = ms - now();
    if (diff <= 30e3) return null; // llegando
    // Minutos contados como en el reloj, para que «N min» cuadre con «Pasa a las HH:MM».
    return Math.max(1, Math.floor(ms / 60000) - Math.floor(now() / 60000));
  }

  function statusOf(a) {
    if (a.canceled) return { cls: "bad", txt: "Cancelado" };
    if (a.skipped) return { cls: "bad", txt: "Hoy no para aquí" };
    if (a.added) return { cls: "ok", txt: "Bus de refuerzo" };
    if (a.source === "sched") return { cls: "muted", txt: a.started ? "Sin datos en directo" : "Según horario" };
    if (a.predMs == null) return { cls: "muted", txt: "Sin predicción" };
    var d = Math.round((a.predMs - a.schedMs) / 60000);
    if (d === 0) return { cls: "ok", txt: "En hora" };
    return d < 0 ? { cls: "ok", txt: -d + " min adelantado" } : { cls: "late", txt: d + " min de retraso" };
  }
  function whereOf(a) {
    var p = a.pos;
    if (!p) return "";
    if (p.stopsLeft === 0) return p.atStop ? "Está en tu parada" : "Llegando a tu parada";
    return (p.atStop ? "En " : "Cerca de ") + esc(p.near) + " · " + (p.stopsLeft === 1 ? "1 parada" : p.stopsLeft + " paradas") + " hasta la tuya";
  }

  function render() {
    var t = now();
    var all = C.computeArrivals(sched, idx, state.feeds || {}, CFG, t);
    var live = all.filter(function (x) { return !x.canceled && !x.skipped; });
    var hero = $("hero"), next = $("next");
    // Buses cancelados o que hoy no paran aquí, antes del próximo que sí pasa: una nota, sin cuenta atrás.
    var gone = all.filter(function (x) { return (x.canceled || x.skipped) && (!live[0] || x.schedMs <= live[0].etaMs); });
    var note = gone.length ? '<p class="hero-note">' + gone.map(function (x) {
      return "El de las " + hm(x.schedMs) + (x.canceled ? " está cancelado" : " hoy no para en tu parada");
    }).join(". ") + ".</p>" : "";
    if (!live.length) {
      hero.className = "hero muted";
      hero.innerHTML = note + '<p class="hero-none">' + (state.feeds ? "No pasa ningún bus en las próximas 3 horas." : state.error ? "Sin datos en directo y sin horario para hoy." : "Cargando…") + "</p>";
      next.textContent = "";
      document.title = "L4 · 15956";
    } else {
      var a = live[0], s = statusOf(a), m = minsLeft(a.etaMs), schedOnly = a.source === "sched";
      var gps = "";
      if (a.pos && a.pos.ahead && a.predMs != null && a.pos.ms < a.predMs - 60e3) {
        gps = '<p class="hero-gps">Según el GPS va más adelantado de lo que dice la predicción: podría pasar hacia las <strong>' + hm(Math.max(a.pos.ms, t)) + "</strong>.</p>";
      }
      hero.className = "hero " + s.cls;
      hero.innerHTML = note +
        '<p class="hero-count">' + (m == null ? '<span class="num small">' + (schedOnly ? "Ahora" : "Llegando") + "</span>" : '<span class="num">' + m + '</span><span class="unit">min</span>') + "</p>" +
        '<p class="hero-time">' + (m == null && a.pos && a.pos.stopsLeft === 0 && a.pos.atStop ? "Ya está aquí" : (schedOnly ? "Según el horario pasa a las <strong>" : "Pasa a las <strong>") + hm(a.etaMs) + "</strong>") +
        ' <span class="chip ' + s.cls + '">' + esc(s.txt) + "</span></p>" +
        (whereOf(a) ? '<p class="hero-where">' + whereOf(a) + "</p>" : "") + gps;
      var b = live[1];
      if (b) {
        var mb = minsLeft(b.etaMs);
        var gap = all.filter(function (x) { return (x.canceled || x.skipped) && x.schedMs > a.etaMs && x.schedMs <= b.etaMs; });
        next.innerHTML = "Después: <strong>" + hm(b.etaMs) + "</strong>" + (mb != null ? " · " + mb + " min" : "") +
          (b.source === "sched" ? " · según horario" : "") + (b.added ? " · refuerzo" : "") +
          gap.map(function (x) { return ' <span class="gap">(el de las ' + hm(x.schedMs) + (x.canceled ? " está cancelado" : " no para aquí") + ")</span>"; }).join("");
      } else next.textContent = "";
      document.title = (m == null ? (schedOnly ? "Ahora (horario)" : "Llegando") : m + " min") + " · L4 Loranca";
    }

    var al = state.feeds ? C.alertsFor(sched, state.feeds, CFG, t) : [];
    $("alerts").hidden = !al.length;
    $("alerts").innerHTML = al.map(function (x) {
      return '<div class="alert"><p class="alert-h">' + esc(x.header) + "</p>" + (x.text ? '<p class="alert-t">' + esc(x.text) + "</p>" : "") + "</div>";
    }).join("");

    var parts = [];
    if (state.loading) parts.push("Actualizando…");
    if (state.feeds && state.feeds.tu && state.feeds.tu.header && state.feeds.tu.header.timestamp) {
      var ts = state.feeds.tu.header.timestamp * 1000, age = Math.round((t - ts) / 1000);
      parts.push("Datos de las " + hmsTxt(ts) + (age > 180 ? ' <span class="stale">(' + (age < 3600 ? "hace " + Math.round(age / 60) + " min" : "hace más de una hora") + ", puede estar desfasado)</span>" : ""));
    }
    if (state.feeds && state.fetchedAt && !(state.feeds.tu && state.feeds.tu.header && state.feeds.tu.header.timestamp)) parts.push("Datos recibidos a las " + hmsTxt(state.fetchedAt + clockOffset));
    $("status").innerHTML = parts.join(" · ") || (state.error ? "Sin datos en directo" : "Descargando datos en directo…");
    $("error").hidden = !state.error;
    if (state.error) {
      var e = state.error, why = e && e.name === "AbortError" ? "El servidor de datos en directo no responde."
        : /servidor respondió|respuesta vacía|protobuf|cable/.test(String(e && e.message)) ? "El servidor de EMT no está dando datos en directo ahora mismo."
        : "No he podido descargar los datos en directo. Comprueba la conexión.";
      $("error").textContent = why + " " + (state.feeds ? "Muestro los últimos que tengo." : "Mientras tanto ves la hora del horario.");
    }

    var covered = !!sched.dates[C.localDate(t)];
    $("expired").hidden = covered;
    $("valid").textContent = ymdTxt(sched.feed.end);
    $("gtfs-msg").textContent = state.gtfsMsg;
  }

  function getFeed(url) {
    // Corta a los 15 s: con mala cobertura una petición colgada no debe bloquear las siguientes.
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
    state.loading = true; state.loadingSince = Date.now(); render();
    Promise.all([getFeed(FEEDS.tu), getFeed(FEEDS.vp).catch(function () { return null; }), getFeed(FEEDS.al).catch(function () { return null; })])
      .then(function (r) { state.feeds = { tu: r[0], vp: r[1], al: r[2] }; state.fetchedAt = Date.now(); state.error = null; })
      .catch(function (e) { state.error = e; })
      .then(function () { state.loading = false; render(); });
  }

  // Solo hace falta cuando caduque el horario incluido.
  function loadGtfs(file) {
    state.gtfsMsg = "Leyendo " + file.name + "…"; render();
    new Promise(function (ok, ko) {
      if (window.JSZip) return ok();
      var s = document.createElement("script"); s.src = JSZIP_URL; s.onload = ok;
      s.onerror = function () { ko(new Error("no se pudo cargar el lector de zip (¿sin conexión?)")); };
      document.head.appendChild(s);
    }).then(function () { return JSZip.loadAsync(file); }).then(function (zip) {
      var names = ["routes.txt", "stops.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt"], texts = {};
      return Promise.all(names.map(function (n) {
        var f = zip.file(n) || zip.file(new RegExp("(^|/)" + n.replace(".", "\\.") + "$"))[0];
        return f ? f.async("string").then(function (t) { texts[n] = t; }) : null;
      })).then(function () { return C.filterSchedule(C.deriveSchedule(function (n) { return texts[n] == null ? null : texts[n]; }), CFG); });
    }).then(function (s) {
      if (!s.patterns.length) throw new Error("no trae la L4 por la parada 15956");
      if (s.feed.end <= sched.feed.end) {
        state.gtfsMsg = "Ese GTFS no es más nuevo que el que ya tengo (válido hasta el " + ymdTxt(sched.feed.end) + "). Descarga el último del NAP.";
        render(); return;
      }
      sched = s; idx = C.indexSchedule(sched);
      var saved = store.set("bus.sched", JSON.stringify(s));
      state.gtfsMsg = "Horario actualizado: válido hasta el " + ymdTxt(s.feed.end) + "." + (saved ? "" : " Este navegador no deja guardarlo y tendrás que cargarlo otra vez.");
      render();
    }).catch(function (e) {
      var why = /zip|signature|central directory|corrupt/i.test(String(e && e.message)) ? "no parece un .zip de GTFS" : (e && e.message) || "error desconocido";
      state.gtfsMsg = "No he podido leer ese archivo: " + why + "."; render();
    });
  }

  $("btn-refresh").addEventListener("click", refresh);
  $("gtfs-file").addEventListener("change", function (e) { if (e.target.files[0]) loadGtfs(e.target.files[0]); e.target.value = ""; });
  $("nap-link").href = NAP_URL;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && (!state.fetchedAt || Date.now() - state.fetchedAt > 10e3)) refresh();
  });

  render();
  refresh();
  setInterval(function () { if (document.visibilityState !== "hidden") refresh(); }, REFRESH_MS);
  setInterval(render, 1000);
})();
