# Max-N-Standorte auf der Karte, ohne verschluckte Ausreißer

Demo: Eine OpenStreetMap-Karte zeigt **höchstens N Standorte**, egal wie viele in der Datenbank liegen, und lässt dabei
keinen isolierten Punkt stillschweigend weg. Zum Vergleich gibt es zwei naive Varianten („alles laden“, „alles im
Ausschnitt“) mit gemessenen Ladezeiten.

- Backend: Node `http` + `pg` (einzige Dependency), PostgreSQL **ohne** PostGIS
- Frontend: eine HTML-Datei, Leaflet vom CDN, kein Build
- Seed: 5000 Parkplätze in Österreich, darunter ~44 Ausreißer in Randgebieten (deterministisch)

```
docker-compose.yml   Dockerfile   package.json
server.js            HTTP-Server: API, index.html, Schema + Seed beim Start
seed.js              deterministischer Generator für die Demo-Daten
schema.sql           Tabelle + GiST-Index (idempotent)
check.js             Prüfskript für die Abnahmekriterien
public/index.html    gesamtes Frontend
```

## 1. Lokal starten

```bash
cp docker-compose.override.example.yml docker-compose.override.yml   # Port 3000 nach außen
POSTGRES_PASSWORD=dev docker compose up --build
```

Dann http://localhost:3000 öffnen. Beim ersten Start wird die leere Tabelle automatisch geseedet; ein Neustart seedet
nicht erneut.

Prüfskript (Abnahmekriterien, läuft direkt gegen die DB):

```bash
POSTGRES_PASSWORD=dev docker compose exec app node check.js
```

Mehr Punkte, damit die Unterschiede deutlich werden:

```bash
POSTGRES_PASSWORD=dev SEED_COUNT=100000 RESEED=true docker compose up -d
```

`RESEED=true` leert die Tabelle bei **jedem** Start und seedet neu. Danach wieder entfernen.

| Variable            | Default | Bedeutung                                              |
|---------------------|---------|--------------------------------------------------------|
| `POSTGRES_PASSWORD` | –       | Pflicht, Passwort für DB und App                       |
| `SEED_COUNT`        | 5000    | Anzahl Standorte beim Seed                             |
| `RESEED`            | false   | `true` = bei jedem Start neu seeden                    |
| `AREA_LIMIT`        | 50000   | Sicherheitsnetz für `/api/area`, danach `truncated`    |

## 2. Deployment auf Coolify

1. Neue Ressource **Docker Compose** aus dem Git-Repo anlegen (Compose-Datei `docker-compose.yml`).
2. Im Coolify-UI die Domain auf den Service **`app`**, Port **3000**, setzen.
3. `POSTGRES_PASSWORD` als Env-Variable setzen. Alternativ eine Coolify-Magic-Variable für ein generiertes Passwort
   verwenden (z. B. `SERVICE_PASSWORD_POSTGRES` statt `POSTGRES_PASSWORD` an beiden Stellen in der Compose-Datei; Syntax
   in der Coolify-Doku prüfen).
4. **Keinen** DB-Port veröffentlichen; `db` ist nur im internen Compose-Netz erreichbar.

Der Server wartet beim Start mit Backoff auf die DB, führt `schema.sql` aus und seedet nur, wenn die Tabelle leer ist.
Healthcheck: `GET /health`.

## 3. Konzept

**Problem:** Mit `LIMIT N` oder einer Zufallsauswahl landen fast nur Punkte aus dichten Gebieten wie Wien auf der
Karte. Ein einzelner Wanderparkplatz im Kaunertal fällt weg. Lädt man dagegen alles, wird der Browser bei vielen
Punkten langsam.

**Lösung: Raster-Ausdünnung in der Datenbank**

1. Über den sichtbaren Ausschnitt wird ein Raster gelegt. Die Zellgröße ist so gewählt, dass höchstens N Zellen
   sichtbar sind (angeschnittene Randzellen mitgezählt).
2. Die Datenbank liefert pro belegter Zelle genau einen Repräsentanten, nämlich den signifikantesten Punkt (hier: größte
   Kapazität), plus die Anzahl der Punkte in der Zelle.
3. Ergebnis: höchstens N Zeilen, unabhängig davon, wie viele Punkte die DB hat.

**Warum keine Ausreißer verschluckt werden:** Ein isolierter Punkt ist allein in seiner Zelle und damit automatisch ihr
Repräsentant. Zusammengefasst werden nur Punkte, die in derselben Zelle liegen und sich auf dem Bildschirm ohnehin
überlappen würden. Die Anzahl macht die Zusammenfassung sichtbar (größerer, oranger Kreis, Tooltip „+ X weitere hier“).
Es fehlt also nichts stillschweigend.

**Warum die Marker beim Verschieben nicht springen:** Das Raster ist an Weltkoordinaten verankert
(`floor(lng / zellbreite)`), nicht am Viewport-Rand. Die Zellgröße hängt nur von Zoomstufe und Fenstergröße ab. In
Nord-Süd-Richtung wird in Web-Mercator-y gerechnet, damit die Zellen auf dem Bildschirm quadratisch sind.

**Kosten:** Die DB berührt nur Punkte im Ausschnitt (GiST-Index). Übertragung und Rendering sind O(N) statt O(alle
Punkte). Bei 100 000 Punkten: ganz Österreich im Rastermodus 1,3 KB gzip statt 1,5 MB für „alles laden“.

## 4. In eigener DB umsetzen

Annahme: Die Tabelle hat bereits `latitude` / `longitude`.

1. **Index anlegen, ohne Downtime:**
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS <tabelle>_pt_gist
     ON <tabelle> USING gist (point(longitude, latitude));
   ```
   Sind die Spalten `numeric`, im Index **und** in der Query identisch auf `double precision` casten:
   `point(longitude::float8, latitude::float8)`. Sonst wird der Index nicht verwendet.
2. **Signifikanz-Spalte wählen:** etwas, das „Wichtigkeit“ ausdrückt (Umsatz, Kapazität, Aktualität …). Gibt es keine,
   im `row_number()` einfach `ORDER BY id`.
3. **Grid-Query übernehmen** (`SQL_GRID` in `server.js`): Tabellen- und Spaltennamen ersetzen und die
   Zellgrößen-Berechnung ins eigene Backend kopieren:
   ```js
   const scale = 256 * 2 ** z;                    // Leaflet-Tilegröße 256
   let c = Math.sqrt((w * h) / n);                // Zellgröße in Pixeln
   while ((Math.ceil(w / c) + 1) * (Math.ceil(h / c) + 1) > n) c *= 1.05;
   const cellLng = (c * 360) / scale;             // Zellbreite in Grad Länge
   const cellY   = (c * 2 * Math.PI) / scale;     // Zellhöhe in Mercator-y
   ```
   Die Garantie „≤ N“ gilt nur, wenn die bbox nicht größer ist als `w × h` Pixel bei Zoom `z`. `server.js` verkleinert
   eine zu große bbox deshalb um ihre Mitte (`fitToViewport`).
4. **Frontend:** bei `moveend` bbox, Zoom, Kartengröße und N schicken; Debounce + `AbortController`; `anzahl` als
   Gruppengröße darstellen.
5. **Prüfen:** mit `EXPLAIN ANALYZE` sicherstellen, dass der GiST-Index genutzt wird
   (`Bitmap Index Scan on <tabelle>_pt_gist`). Bei sehr kleinen Tabellen wählt Postgres zu Recht einen Seq Scan.

## 5. Skalierung (Millionen Punkte)

Die Grid-Query berührt alle Punkte im Ausschnitt. Bei Millionen Punkten im Ausschnitt wird die DB-Seite teuer
(bei 100 000 Punkten und ganz Österreich: ~140 ms). Dann:

- Pro Punkt `min_zoom` vorberechnen: die niedrigste Zoomstufe, auf der der Punkt Repräsentant seiner Zelle in einem
  festen Weltraster ist.
- Abfrage dann `WHERE <bbox> AND min_zoom <= :z ORDER BY … LIMIT :n`, rein indexbasiert (Index auf
  `(min_zoom, point(...))` bzw. GiST + B-Tree).
- Neue Punkte inkrementell einsortieren (nur die betroffenen Zellen pro Zoomstufe neu bewerten).
- Alternative mit PostGIS: `ST_SnapToGrid` + `ST_MakeEnvelope`.

## 6. Grenzen

- **bbox über den 180°-Meridian** wird nicht unterstützt (`minx > maxx` → 400). Für Österreich irrelevant.
- **Repräsentant ist ein echter Punkt, kein Schwerpunkt.** Bewusst so, damit ein Klick einen echten Standort zeigt.
  Der Kreis einer Gruppe sitzt deshalb am größten Standort der Zelle, nicht in ihrer Mitte.
- **Kleines N auf großem Ausschnitt fasst grob zusammen.** Bei N=100 und ganz Österreich auf einem 1280×800-Bildschirm
  ist eine Zelle ~100 km breit, und nur ~19 der 100 Zellen liegen über Österreich. Jede davon enthält auch Stadt- und
  Hintergrundpunkte mit größerer Kapazität. Die Ausreißer sind dann **gezählt** (in der Gruppe enthalten), aber nicht
  **einzeln gezeichnet**. Einzeln erscheinen sie, sobald sie allein in ihrer Zelle sind: beim Hineinzoomen (meist ab
  Zoom 10–12 bei N=100) oder auf dem Handy-Ausschnitt bei größerem N. `check.js` gibt die Werte pro Ausreißer aus.
- Der Gruppenkreis ist im Frontend auf eine halbe Zellgröße begrenzt, damit sich Nachbarzellen auf kleinen Bildschirmen
  nicht überlappen.
- Die Messwerte „Netzwerk + Parse“ sind eine Näherung (`Gesamtzeit bis JSON − DB-Zeit`).
