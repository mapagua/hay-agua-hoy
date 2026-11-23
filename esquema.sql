-- Base de datos de avisos y opiniones. Pegar entero en la consola de D1 una sola vez.

CREATE TABLE IF NOT EXISTS avisos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,   -- segundos, redondeado a 10 minutos
  fecha     TEXT    NOT NULL,   -- AAAA-MM-DD, hora de Canarias
  localidad TEXT    NOT NULL,   -- id de la lista cerrada
  estado    TEXT    NOT NULL CHECK (estado IN ('sin', 'poca', 'con')),
  huella    TEXT,               -- huella de la conexión; se borra a los dos días
  movil     TEXT,               -- huella del número al azar del móvil; se borra a los dos días
  cuenta    INTEGER NOT NULL DEFAULT 1  -- 0 si el aviso llegó desde fuera de España
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

CREATE TABLE IF NOT EXISTS opiniones (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  tipo  TEXT NOT NULL CHECK (tipo IN ('error', 'pueblo', 'idea', 'otro')),
  texto TEXT NOT NULL CHECK (length(texto) <= 1000)
);

-- Para leer los mensajes del buzón:
-- SELECT * FROM opiniones ORDER BY id DESC;
