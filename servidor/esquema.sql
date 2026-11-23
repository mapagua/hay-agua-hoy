-- Base de datos de avisos. Pegar entero en la consola de D1 una sola vez.

CREATE TABLE IF NOT EXISTS avisos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,   -- segundos, redondeado a 10 minutos
  fecha     TEXT    NOT NULL,   -- AAAA-MM-DD, hora de Canarias
  localidad TEXT    NOT NULL,   -- id de la lista cerrada
  estado    TEXT    NOT NULL CHECK (estado IN ('sin', 'poca', 'con')),
  huella    TEXT                -- se borra a los dos días
);
CREATE INDEX IF NOT EXISTS avisos_ts ON avisos (ts);
CREATE INDEX IF NOT EXISTS avisos_fecha ON avisos (fecha, localidad);

CREATE TABLE IF NOT EXISTS dias (
  fecha       TEXT    NOT NULL,
  localidad   TEXT    NOT NULL,
  vecinos_sin INTEGER NOT NULL, -- vecinos distintos que avisaron "sin agua" ese día
  avisos_sin  INTEGER NOT NULL,
  avisos_poca INTEGER NOT NULL,
  avisos_con  INTEGER NOT NULL,
  PRIMARY KEY (fecha, localidad)
);

CREATE TABLE IF NOT EXISTS limites (
  clave  TEXT PRIMARY KEY,
  caduca INTEGER NOT NULL,
  cuenta INTEGER NOT NULL DEFAULT 1
);
