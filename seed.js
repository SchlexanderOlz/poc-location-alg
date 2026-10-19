'use strict';
// Deterministischer Generator für die Demo-Daten: Parkplätze in Österreich.
// Gleicher PRNG-Seed => jede Instanz bekommt exakt dieselben Punkte.

const PRNG_SEED = 20261019;

// Vereinfachter Umriss Österreichs, [lng, lat]. Basis: Natural Earth 110m
// Admin-0, an der Nordgrenze (Waldviertel/Weinviertel) leicht verfeinert.
// Reicht, um Punkte grob auf österreichisches Gebiet zu beschränken.
const AUSTRIA = [
  [16.979667, 48.123497], [16.903754, 47.714866], [16.340584, 47.712902],
  [16.534268, 47.496171], [16.202298, 46.852386], [16.011664, 46.683611],
  [15.137092, 46.658703], [14.632472, 46.431817], [13.806475, 46.509306],
  [12.376485, 46.767559], [12.153088, 47.115393], [11.164828, 46.941579],
  [11.048556, 46.751359], [10.442701, 46.893546], [9.932448, 46.920728],
  [9.47997, 47.10281], [9.632932, 47.347601], [9.594226, 47.525058],
  [9.896068, 47.580197], [10.402084, 47.302488], [10.544504, 47.566399],
  [11.426414, 47.523766], [12.141357, 47.703083], [12.62076, 47.672388],
  [12.932627, 47.467646], [13.025851, 47.637584], [12.884103, 48.289146],
  [13.243357, 48.416115], [13.595946, 48.877172], [14.338898, 48.555305],
  [14.901447, 48.964402], [15.253416, 49.039074], [15.6, 48.96],
  [15.86, 48.87], [16.1, 48.75], [16.4, 48.74],
  [16.499283, 48.785808], [16.960288, 48.596982], [16.879983, 48.470013],
];

// weight = Anteil an den städtischen Punkten (%), sigma in km.
const CITIES = [
  { name: 'Wien', lat: 48.208, lng: 16.374, weight: 35, sigma: 8 },
  { name: 'Graz', lat: 47.071, lng: 15.44, weight: 12, sigma: 5 },
  { name: 'Linz', lat: 48.307, lng: 14.286, weight: 9, sigma: 5 },
  { name: 'Salzburg', lat: 47.81, lng: 13.055, weight: 8, sigma: 4 },
  { name: 'Innsbruck', lat: 47.269, lng: 11.404, weight: 7, sigma: 4 },
  { name: 'Klagenfurt', lat: 46.625, lng: 14.305, weight: 5, sigma: 3.5 },
  { name: 'Villach', lat: 46.611, lng: 13.856, weight: 3, sigma: 3 },
  { name: 'Wels', lat: 48.158, lng: 14.029, weight: 3, sigma: 3 },
  { name: 'St. Pölten', lat: 48.205, lng: 15.626, weight: 3, sigma: 3 },
  { name: 'Dornbirn', lat: 47.413, lng: 9.742, weight: 1.8, sigma: 3 },
  { name: 'Bregenz', lat: 47.503, lng: 9.747, weight: 1.2, sigma: 2.5 },
];

// Der Rest (12 %) verteilt sich gleichmäßig auf Bezirksstädte.
const DISTRICT_TOWNS = [
  ['Feldkirch', 47.237, 9.598], ['Bludenz', 47.155, 9.822], ['Imst', 47.245, 10.739],
  ['Schwaz', 47.352, 11.709], ['Kufstein', 47.583, 12.17], ['Lienz', 46.83, 12.769],
  ['Zell am See', 47.325, 12.795], ['Hallein', 47.683, 13.097], ['Bad Ischl', 47.711, 13.621],
  ['Gmunden', 47.918, 13.799], ['Braunau', 48.258, 13.035], ['Steyr', 48.042, 14.421],
  ['Amstetten', 48.123, 14.873], ['Krems', 48.41, 15.603], ['Tulln', 48.33, 16.054],
  ['Mödling', 48.086, 16.288], ['Baden', 48.006, 16.234], ['Wiener Neustadt', 47.815, 16.244],
  ['Eisenstadt', 47.846, 16.527], ['Leoben', 47.383, 15.094], ['Kapfenberg', 47.444, 15.293],
  ['Leibnitz', 46.781, 15.539], ['Wolfsberg', 46.841, 14.844], ['Spittal an der Drau', 46.796, 13.495],
];
const DISTRICT_WEIGHT = 12;

// Explizite Ausreißer in Randgebieten: Einzelpunkte oder Mini-Gruppen (1–3).
// Diese dürfen auch knapp außerhalb des vereinfachten Polygons liegen.
const OUTLIERS = [
  ['Wanderparkplatz Kaunertaler Gletscher', 46.86, 10.71],
  ['Parkplatz Obergurgl', 46.87, 11.03],
  ['Wanderparkplatz Vent', 46.86, 10.91],
  ['Parkplatz Nauders', 46.89, 10.5],
  ['Parkplatz Galtür', 46.97, 10.19],
  ['Parkplatz Bielerhöhe (Silvretta)', 46.92, 10.09],
  ['Parkplatz Gargellen', 46.97, 9.92],
  ['Parkplatz Steeg im Lechtal', 47.24, 10.29],
  ['Parkplatz Warth am Arlberg', 47.26, 10.18],
  ['Parkplatz Schröcken', 47.26, 10.09],
  ['Wanderparkplatz Baad (Kleinwalsertal)', 47.31, 10.12],
  ['Parkplatz Hinterriß', 47.48, 11.47],
  ['Parkplatz Achenkirch', 47.52, 11.71],
  ['Parkplatz Gerlos', 47.22, 12.03],
  ['Wanderparkplatz Krimmler Wasserfälle', 47.21, 12.17],
  ['Parkplatz Kaiser-Franz-Josefs-Höhe', 47.075, 12.75],
  ['Parkplatz Kals am Großglockner', 47.0, 12.64],
  ['Parkplatz Sillian', 46.75, 12.42],
  ['Parkplatz Lesachtal', 46.69, 12.83],
  ['Parkplatz Kötschach-Mauthen', 46.67, 13.0],
  ['Parkplatz Nassfeld', 46.56, 13.28],
  ['Parkplatz Mallnitz', 46.99, 13.17],
  ['Parkplatz Hüttschlag', 47.18, 13.23],
  ['Parkplatz Turracher Höhe', 46.92, 13.88],
  ['Parkplatz Bad Eisenkappel', 46.49, 14.59],
  ['Parkplatz Soboth', 46.68, 15.07],
  ['Parkplatz Gosausee', 47.53, 13.5],
  ['Parkplatz Hinterstoder', 47.7, 14.15],
  ['Parkplatz Hohentauern', 47.43, 14.48],
  ['Wanderparkplatz Johnsbach (Gesäuse)', 47.54, 14.58],
  ['Wanderparkplatz Lunz am See', 47.86, 15.03],
  ['Parkplatz Mariazell', 47.77, 15.32],
  ['Parkplatz Hochwechsel', 47.53, 15.91],
  ['Parkplatz Schwarzenberg am Böhmerwald', 48.73, 13.83],
  ['Parkplatz Ulrichsberg', 48.68, 13.91],
  ['Parkplatz Litschau', 48.94, 15.04],
  ['Parkplatz Gmünd (NÖ)', 48.77, 14.98],
  ['Parkplatz Drosendorf', 48.87, 15.62],
  ['Nationalpark-Parkplatz Hardegg', 48.85, 15.86],
  ['Parkplatz Hainburg an der Donau', 48.15, 16.94],
  ['Parkplatz Apetlon (Lange Lacke)', 47.74, 16.83],
  ['Parkplatz Rechnitz', 47.3, 16.44],
  ['Parkplatz Jennersdorf', 46.94, 16.14],
  ['Parkplatz Bad Radkersburg', 46.69, 15.99],
];

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInPolygon(lng, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// Teilt total nach Gewichten auf, Summe bleibt exakt (größter Rest).
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % order.length][1]]++;
  return out;
}

function generate(count = 5000) {
  const rand = mulberry32(PRNG_SEED);
  const uniform = (a, b) => a + (b - a) * rand();
  const randInt = (a, b) => Math.floor(uniform(a, b + 1));
  const gauss = () => {
    const u = 1 - rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  // Log-Verteilung mit Schiefe: viele kleine, wenige große Kapazitäten.
  const logCap = (min, max, skew) => Math.round(min * (max / min) ** (rand() ** skew));
  const offset = (lat, lng, sigmaKm) => {
    const dLat = (gauss() * sigmaKm) / 111.32;
    const dLng = (gauss() * sigmaKm) / (111.32 * Math.cos((lat * Math.PI) / 180));
    return [lat + dLat, lng + dLng];
  };

  const names = [];
  const lats = [];
  const lngs = [];
  const caps = [];
  const push = (name, lat, lng, cap) => {
    names.push(name);
    lats.push(round6(lat));
    lngs.push(round6(lng));
    caps.push(cap);
  };

  // 1) Ausreißer zuerst: ihre Anzahl ist fix, der Rest teilt sich auf.
  for (const [name, lat, lng] of OUTLIERS) {
    if (names.length >= count) break;
    const size = randInt(1, 3);
    push(name, lat, lng, randInt(5, 40));
    for (let k = 2; k <= size && names.length < count; k++) {
      const [la, ln] = offset(lat, lng, 0.4);
      push(`${name} (P${k})`, la, ln, randInt(5, 40));
    }
  }

  // 2) Städtische Cluster (~85 %) und ländlicher Hintergrund (~14 %).
  const remaining = count - names.length;
  const cityTotal = Math.round(remaining * 0.86);
  const ruralTotal = remaining - cityTotal;

  const centers = [
    ...CITIES,
    ...DISTRICT_TOWNS.map(([name, lat, lng]) => ({
      name, lat, lng, weight: DISTRICT_WEIGHT / DISTRICT_TOWNS.length, sigma: 2,
    })),
  ];
  const perCenter = allocate(cityTotal, centers.map((c) => c.weight));
  centers.forEach((c, i) => {
    for (let k = 1; k <= perCenter[i]; k++) {
      let lat = c.lat;
      let lng = c.lng;
      for (let tries = 0; tries < 50; tries++) {
        const [la, ln] = offset(c.lat, c.lng, c.sigma);
        if (pointInPolygon(ln, la, AUSTRIA)) { lat = la; lng = ln; break; }
      }
      const cap = logCap(20, 800, 2.2);
      push(`${cap >= 300 ? 'Parkhaus' : 'Parkplatz'} ${c.name} #${k}`, lat, lng, cap);
    }
  });

  const minLng = Math.min(...AUSTRIA.map((p) => p[0]));
  const maxLng = Math.max(...AUSTRIA.map((p) => p[0]));
  const minLat = Math.min(...AUSTRIA.map((p) => p[1]));
  const maxLat = Math.max(...AUSTRIA.map((p) => p[1]));
  for (let k = 1; k <= ruralTotal; k++) {
    let lat;
    let lng;
    do {
      lat = uniform(minLat, maxLat);
      lng = uniform(minLng, maxLng);
    } while (!pointInPolygon(lng, lat, AUSTRIA));
    push(`Parkplatz (ländlich) #${k}`, lat, lng, logCap(10, 150, 1.5));
  }

  return { names, lats, lngs, caps };
}

async function seed(client, count) {
  const { names, lats, lngs, caps } = generate(count);
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE locations RESTART IDENTITY');
    const BATCH = 20000;
    for (let i = 0; i < names.length; i += BATCH) {
      await client.query(
        `INSERT INTO locations (name, latitude, longitude, capacity)
         SELECT * FROM unnest($1::text[], $2::float8[], $3::float8[], $4::int[])`,
        [names.slice(i, i + BATCH), lats.slice(i, i + BATCH), lngs.slice(i, i + BATCH), caps.slice(i, i + BATCH)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  await client.query('ANALYZE locations');
  return names.length;
}

module.exports = { generate, seed, OUTLIERS, AUSTRIA, pointInPolygon };
