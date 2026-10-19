CREATE TABLE IF NOT EXISTS locations (
  id         serial PRIMARY KEY,
  name       text             NOT NULL,
  latitude   double precision NOT NULL,
  longitude  double precision NOT NULL,
  capacity   integer          NOT NULL   -- Signifikanz: Anzahl Stellplätze
);

-- Räumlicher Index ohne PostGIS: GiST-Expression-Index auf den Postgres-Typ point.
-- WICHTIG: Der Ausdruck muss in den Queries exakt gleich lauten: point(longitude, latitude)
CREATE INDEX IF NOT EXISTS locations_pt_gist
  ON locations USING gist (point(longitude, latitude));
