// node build.js <dir_gtfs> <salida.html>
const fs = require("fs"), path = require("path");
const C = require("./core.js");
const [gdir, outFile] = process.argv.slice(2);
const full = C.deriveSchedule(n => { const p = path.join(gdir, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; });
const sched = C.filterSchedule(full, { route: "4", dir: 0, stop: "15956" });
const json = JSON.stringify(sched).replace(/</g, "\\u003c");
const safe = s => s.replace(/<\/script/gi, "<\\/script");
let html = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
html = html
  .replace("/*DATA*/", () => "window.BUS_SCHEDULE = " + json + ";")
  .replace("/*CORE*/", () => safe(fs.readFileSync(path.join(__dirname, "core.js"), "utf8")))
  .replace("/*APP*/", () => safe(fs.readFileSync(path.join(__dirname, "app.js"), "utf8")));
fs.writeFileSync(outFile, html);
console.log("escrito", outFile, (html.length / 1024).toFixed(0) + " KB", "patrones", sched.patterns.length, "fechas", Object.keys(sched.dates).length, sched.feed);
