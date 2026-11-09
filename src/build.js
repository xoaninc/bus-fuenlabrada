// node build.js <dir_gtfs> <index.html> [paradas.html]
// index.html: solo la L4 → Loranca en la parada 15956. paradas.html: buscador y paradas cercanas (todas las líneas).
const fs = require("fs"), path = require("path");
const C = require("./core.js");
const [gdir, outFile, outParadas] = process.argv.slice(2);
const full = C.deriveSchedule(n => { const p = path.join(gdir, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; });
const safe = s => s.replace(/<\/script/gi, "<\\/script");
const core = safe(fs.readFileSync(path.join(__dirname, "core.js"), "utf8"));
function page(template, app, sched, out) {
  const json = JSON.stringify(sched).replace(/</g, "\\u003c");
  const html = fs.readFileSync(path.join(__dirname, template), "utf8")
    .replace("/*DATA*/", () => "window.BUS_SCHEDULE = " + json + ";")
    .replace("/*CORE*/", () => core)
    .replace("/*APP*/", () => safe(fs.readFileSync(path.join(__dirname, app), "utf8")));
  fs.writeFileSync(out, html);
  console.log("escrito", out, (html.length / 1024).toFixed(0) + " KB", "patrones", sched.patterns.length, "fechas", Object.keys(sched.dates).length, sched.feed);
}
page("template.html", "app.js", C.filterSchedule(full, { route: "4", dir: 0, stop: "15956" }), outFile);
if (outParadas) page("paradas.template.html", "paradas.js", full, outParadas);
