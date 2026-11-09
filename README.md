# bus-fuenlabrada

Cuánto le queda al próximo bus **L4 de EMT Fuenlabrada, dirección Loranca**, en la parada **15956 (Avenida Regiones - Nazaret)**.

**Abrir:** https://xoaninc.github.io/bus-fuenlabrada/

En el iPhone: ábrela en Safari → Compartir → «Añadir a pantalla de inicio».

**Otras paradas:** https://xoaninc.github.io/bus-fuenlabrada/paradas.html — buscador por número o nombre de parada y las 3 paradas más cercanas a tu ubicación, con los próximos buses de todas las líneas. Se puede enlazar una parada concreta: `paradas.html#15956`.

## De dónde salen los datos

- **Tiempo real**: feeds GTFS-Realtime públicos de EMTF enlazados en el [NAP](https://nap.transportes.gob.es/ConjuntoDato/Detail/1628) y servidos por Optibus (`https://api.control.optibus.co/opendata/v1/gtfs-rt/{trip-updates,vehicle-positions,alerts}?uid=c-5cfcd2d1`). No necesitan clave. La página los descarga cada 30 s.
- **Horario**: el GTFS-ZIP de EMTF del NAP, incluido en la página (solo los viajes de la L4 hacia Loranca que paran en la 15956). Cuando caduca, la página avisa y deja cargar el GTFS nuevo desde el propio móvil; mientras tanto usa el horario equivalente del día de la semana.

La hora prevista es la del horario más el retraso que publica EMTF. Con el GPS se muestra por dónde va el bus y cuántas paradas le faltan.

## Actualización automática del horario

La acción `.github/workflows/actualizar-horario.yml` se ejecuta cada mañana: baja el GTFS-ZIP de EMTF del NAP, regenera `index.html` y `paradas.html` y los publica si han cambiado. Necesita la clave de la API del NAP guardada como secreto del repositorio con el nombre `NAP_API_KEY` (Settings → Secrets and variables → Actions → New repository secret). También se puede lanzar a mano desde la pestaña Actions → «Actualizar horario» → Run workflow.

## Regenerar la página a mano con un GTFS nuevo

```sh
unzip EMTF.zip -d gtfs
node src/build.js gtfs index.html paradas.html
```

`src/core.js` es el motor (horario, decodificador GTFS-RT y cálculo de llegadas); `src/app.js` y `src/template.html` son la página principal, y `src/paradas.js` y `src/paradas.template.html` la del buscador.
