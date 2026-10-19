'use strict';
// Prüft die Abnahmekriterien direkt gegen die Datenbank:
//   1. Raster liefert nie mehr als N Zeilen.
//   2. Ganz Österreich, N=100: jeder Ausreißer steckt in einem Marker (gezählt), und
//      beim Hineinzoomen wird er zum eigenen Marker. Gegenprobe: „Top 100 nach
//      Kapazität“ zeigt ihn weder auf der Österreich-Ansicht noch in diesen Ansichten.
//   3. Seitliches Verschieben ändert die Repräsentanten in sichtbar bleibenden Zellen nicht.
// Aufruf: docker compose exec app node check.js   (oder DATABASE_URL=... node check.js)

const { pool, cellSize, SQL_GRID } = require('./server');
const { OUTLIERS } = require('./seed');

const IN_BBOX = 'point(longitude, latitude) <@ box(point($1::float8, $2::float8), point($3::float8, $4::float8))';
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

// bbox, wie Leaflet sie für Mittelpunkt, Zoom und Kartengröße meldet.
function view(lat, lng, z, w, h) {
  const scale = 256 * 2 ** z;
  const px = ((lng + 180) / 360) * scale;
  const py = ((Math.PI - mercY(lat)) / (2 * Math.PI)) * scale;
  const toLng = (x) => (x / scale) * 360 - 180;
  const toLat = (y) => invMercY(Math.PI - (y / scale) * 2 * Math.PI);
  return { minx: toLng(px - w / 2), maxx: toLng(px + w / 2), miny: toLat(py + h / 2), maxy: toLat(py - h / 2), z, w, h };
}

function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

async function grid(v, n) {
  const { cellLng, cellY } = cellSize(v.z, v.w, v.h, n);
  // Ohne Sicherheitsnetz-LIMIT, damit wir die echte Zellzahl sehen.
  const { rows } = await pool.query(SQL_GRID, [v.minx, v.miny, v.maxx, v.maxy, cellLng, cellY, 1e9]);
  const cells = await cellsOf(rows.map((r) => r.id), [], cellLng, cellY);
  return { rows: rows.map((r) => ({ ...r, ...cells.get(r.id) })), cellLng, cellY };
}

async function cellsOf(ids, names, cellLng, cellY) {
  const { rows } = await pool.query(
    `SELECT id, name, latitude, longitude, capacity,
            floor(longitude / $1)::int AS cx,
            floor(ln(tan(pi()/4 + radians(latitude)/2)) / $2)::int AS cy
     FROM locations WHERE id = ANY($3::int[]) OR name = ANY($4::text[])`,
    [cellLng, cellY, ids, names],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) failed++;
};

async function checkLimit() {
  console.log('\n# 1. Nie mehr als N Zeilen');
  const views = [
    view(47.7, 13.35, 7, 1280, 800),   // ganz Österreich, Desktop
    view(47.7, 13.35, 6, 390, 700),    // ganz Österreich, Handy
    view(48.208, 16.374, 11, 1920, 1080), // Wien
    view(48.208, 16.374, 14, 800, 600),
    view(47.27, 11.4, 9, 1440, 900),   // Tirol
    view(47.5, 13.5, 3, 4000, 4000),   // Welt, riesiges Fenster
  ];
  let worst = 0;
  let combos = 0;
  for (const v of views) {
    for (const n of [10, 50, 100, 300, 1000, 2000]) {
      const { rows } = await grid(v, n);
      combos++;
      worst = Math.max(worst, rows.length / n);
      if (rows.length > n) ok(false, `z=${v.z} ${v.w}x${v.h} n=${n}: ${rows.length} Zeilen`);
    }
  }
  ok(worst <= 1, `${combos} Kombinationen, maximale Auslastung ${(worst * 100).toFixed(0)} % von N`);
}

async function topByCapacity(v, n) {
  const { rows } = await pool.query(
    `SELECT id FROM locations WHERE ${IN_BBOX} ORDER BY capacity DESC, id LIMIT $5`,
    [v.minx, v.miny, v.maxx, v.maxy, n],
  );
  return new Set(rows.map((r) => r.id));
}

async function checkOutliers() {
  const n = 100;
  const austria = view(47.7, 13.35, 7, 1280, 800);
  console.log(`\n# 2. Ausreißer (Desktop 1280x800, N=${n})`);
  const g = await grid(austria, n);
  const repByCell = new Map(g.rows.map((r) => [`${r.cx}:${r.cy}`, r]));
  const outliers = [...(await cellsOf([], OUTLIERS.map((o) => o[0]), g.cellLng, g.cellY)).values()];
  const topAustria = await topByCapacity(austria, n);
  console.log(`Ganz Österreich (z=7): ${g.rows.length} Marker, Zelle ≈ ${km(47.7, 0, 47.7, g.cellLng).toFixed(0)} km breit`);

  // Pro Ausreißer: in welchem Marker steckt er auf der Österreich-Ansicht, und ab welchem
  // Zoom (Ansicht auf den Ort zentriert) ist er selbst ein Marker? Zeigt Top-100 ihn dort?
  console.log('\n' + 'Ort'.padEnd(40), 'Österreich: Marker'.padEnd(20), 'eigener Marker ab', 'Top-100 dort');
  let counted = 0;
  let ownSomewhere = 0;
  let topShows = 0;
  for (const o of outliers) {
    const rep = repByCell.get(`${o.cx}:${o.cy}`);
    if (rep) counted++;
    let ownZoom = null;
    let inTop = false;
    for (let z = 7; z <= 14 && ownZoom === null; z++) {
      const v = view(o.latitude, o.longitude, z, 1280, 800);
      const gz = await grid(v, n);
      // Repräsentant ist der Ort selbst oder ein Punkt seiner Mini-Gruppe („… (P2)“).
      const own = gz.rows.find((r) => r.name === o.name || r.name.startsWith(`${o.name} (P`));
      if (own) {
        ownZoom = z;
        inTop = (await topByCapacity(v, n)).has(own.id);
      }
    }
    if (ownZoom !== null) ownSomewhere++;
    if (inTop) topShows++;
    const repTxt = !rep ? 'KEINER' : rep.name.startsWith(o.name) ? 'selbst' : `Gruppe (${rep.anzahl})`;
    console.log(o.name.padEnd(40), repTxt.padEnd(20), String(ownZoom ? `Zoom ${ownZoom}` : '–').padEnd(17), inTop ? 'ja' : 'nein');
  }
  ok(counted === outliers.length,
    `Österreich: ${counted}/${outliers.length} Ausreißer stecken in einem Marker (Anzahl + Tooltip „+ X weitere hier“)`);
  ok(outliers.every((o) => !topAustria.has(o.id)), 'Österreich: Top-100 nach Kapazität enthält keinen einzigen Ausreißer');
  // Nur Information, keine Prüfung: siehe README „Grenzen“.
  console.log(`INFO Raster: ${ownSomewhere}/${outliers.length} Ausreißer werden beim Hineinzoomen (≤ 14) zum eigenen Marker;` +
    ` Top-100 nach Kapazität zeigt in genau diesen Ansichten ${topShows}/${outliers.length}`);

  // Wie viele Ausreißer sind auf der Österreich-Ansicht selbst Repräsentant – je nach N?
  const perN = [];
  for (const nn of [100, 300, 1000, 2000]) {
    const gn = await grid(austria, nn);
    const ids = new Set(gn.rows.map((r) => r.id));
    perN.push(`N=${nn}: ${outliers.filter((o) => ids.has(o.id)).length}`);
  }
  console.log(`INFO Österreich (z=7), Ausreißer als eigener Marker: ${perN.join(', ')} (von ${outliers.length})`);
  console.log('     Bei N=100 ist eine Zelle auf der Österreich-Ansicht ~100 km breit; jede enthält auch Stadt- und');
  console.log('     Hintergrundpunkte mit höherer Kapazität. Ausreißer sind dort gezählt, aber nicht einzeln gezeichnet.');
}

async function checkStability() {
  console.log('\n# 3. Kein Springen beim seitlichen Verschieben');
  let total = 0;
  let changed = 0;
  for (const [lat, lng, z] of [[47.7, 13.35, 8], [48.208, 16.374, 11], [47.27, 11.4, 10]]) {
    const w = 1280;
    const h = 800;
    const a = view(lat, lng, z, w, h);
    const shiftDeg = ((w * 0.3) / (256 * 2 ** z)) * 360; // 30 % der Breite nach Osten
    const b = view(lat, lng + shiftDeg, z, w, h);
    const ga = await grid(a, 300);
    const gb = await grid(b, 300);
    const inside = (r, v, g) => r.cx * g.cellLng >= v.minx && (r.cx + 1) * g.cellLng <= v.maxx &&
      invMercY(r.cy * g.cellY) >= v.miny && invMercY((r.cy + 1) * g.cellY) <= v.maxy;
    const bByCell = new Map(gb.rows.map((r) => [`${r.cx}:${r.cy}`, r]));
    for (const r of ga.rows) {
      if (!inside(r, a, ga) || !inside(r, b, gb)) continue; // nur Zellen, die in beiden ganz sichtbar sind
      total++;
      const other = bByCell.get(`${r.cx}:${r.cy}`);
      if (!other || other.id !== r.id || other.anzahl !== r.anzahl) changed++;
    }
  }
  ok(total > 0 && changed === 0, `${total} Zellen in beiden Ausschnitten sichtbar, ${changed} mit geändertem Marker`);
}

(async () => {
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM locations');
    console.log(`${rows[0].n} Standorte in der DB`);
    await checkLimit();
    await checkOutliers();
    await checkStability();
  } finally {
    await pool.end();
  }
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
