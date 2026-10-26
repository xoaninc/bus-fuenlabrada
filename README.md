# bus-fuenlabrada

Cuánto le queda al próximo bus **L4 de EMT Fuenlabrada, dirección Loranca**, en la parada **15956 (Avenida Regiones - Nazaret)**.

**Abrir:** https://xoaninc.github.io/bus-fuenlabrada/

En el iPhone: ábrela en Safari → Compartir → «Añadir a pantalla de inicio».

## De dónde salen los datos

- **Tiempo real**: feeds GTFS-Realtime públicos de EMTF enlazados en el [NAP](https://nap.transportes.gob.es/ConjuntoDato/Detail/1628) y servidos por Optibus (`https://api.control.optibus.co/opendata/v1/gtfs-rt/{trip-updates,vehicle-positions,alerts}?uid=c-5cfcd2d1`). No necesitan clave. La página los descarga cada 30 s.
- **Horario**: el GTFS-ZIP de EMTF del NAP, incluido en la página (solo los viajes de la L4 hacia Loranca que paran en la 15956). Cuando caduca, la página avisa y deja cargar el GTFS nuevo desde el propio móvil; mientras tanto usa el horario equivalente del día de la semana.

La hora prevista es la del horario más el retraso que publica EMTF. Con el GPS se muestra por dónde va el bus y cuántas paradas le faltan.

## Regenerar la página con un GTFS nuevo

```sh
unzip EMTF.zip -d gtfs
node src/build.js gtfs index.html
```

`src/core.js` es el motor (horario, decodificador GTFS-RT y cálculo de llegadas); `src/app.js` y `src/template.html` son la interfaz.
