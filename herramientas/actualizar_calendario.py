#!/usr/bin/env python3
"""Lee el calendario oficial de suspensiones programadas y lo guarda en datos/calendario.json.

Uso:
    python3 herramientas/actualizar_calendario.py                 # lee la web oficial
    python3 herramientas/actualizar_calendario.py --archivo p.html # lee una página guardada a mano

Solo usa la biblioteca estándar de Python. Reglas que sigue:
  - Respeta el robots.txt de la web oficial. Si no permite la lectura, se detiene y lo dice.
  - Si no encuentra ningún corte, no toca los datos y termina con error (mejor dato viejo
    y fechado que un calendario vacío por un cambio de formato).
  - Los días ya pasados quedan congelados tal y como se leyeron en su momento.
"""
import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

URL = "https://aguasdelanzaroteylagraciosa.com/suspensiones-programadas-del-suministro/"
AGENTE = "HayAguaHoy/1.0 (lectura diaria del calendario publico de cortes)"
RAIZ = Path(__file__).resolve().parent.parent
F_CALENDARIO = RAIZ / "datos" / "calendario.json"
F_LOCALIDADES = RAIZ / "datos" / "localidades.json"
CANARIAS = ZoneInfo("Atlantic/Canary")

MESES = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7,
         "agosto": 8, "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12}
RE_MES_ANIO = re.compile(r"\b(" + "|".join(MESES) + r")\s+(?:de\s+)?(20\d\d)\b", re.I)
RE_FECHA = re.compile(r"\b(\d{1,2})\s+de\s+(" + "|".join(MESES) + r")\s+de\s+(20\d\d)\b", re.I)
RE_DIA_COL = re.compile(r"^\s*(\d{1,2})\s*(lun|mar|mi[eé]|jue|vie|s[aá]b|dom)", re.I)
RE_HORAS = re.compile(r"(\d{1,2})[:.](\d{2})\s*(?:h\.?)?\s*(?:-|–|—|a|hasta)\s*(\d{1,2})[:.](\d{2})", re.I)


def slug(texto):
    t = unicodedata.normalize("NFD", texto.strip().lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


class LectorTablas(HTMLParser):
    """Saca todas las tablas de la página como listas de filas, con el último titular que las precede."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tablas = []          # [{"titular": str, "filas": [[celda, ...], ...]}]
        self._titular = ""
        self._en_titular = False
        self._buf_titular = []
        self._tabla = None
        self._fila = None
        self._celda = None
        self._ignorar = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._ignorar += 1
        elif tag in ("h1", "h2", "h3", "h4", "h5", "caption", "summary"):
            self._en_titular, self._buf_titular = True, []
        elif tag == "table":
            self._tabla = {"titular": self._titular, "filas": []}
        elif tag == "tr" and self._tabla is not None:
            self._fila = []
        elif tag in ("td", "th") and self._fila is not None:
            self._celda = []
        elif tag == "br" and self._celda is not None:
            self._celda.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._ignorar = max(0, self._ignorar - 1)
        elif tag in ("h1", "h2", "h3", "h4", "h5", "caption", "summary") and self._en_titular:
            self._en_titular = False
            texto = " ".join("".join(self._buf_titular).split())
            if texto:
                self._titular = texto
                if self._tabla is not None and tag == "caption":
                    self._tabla["titular"] = texto
        elif tag in ("td", "th") and self._celda is not None and self._fila is not None:
            self._fila.append(" ".join("".join(self._celda).split()))
            self._celda = None
        elif tag == "tr" and self._fila is not None and self._tabla is not None:
            if self._fila:
                self._tabla["filas"].append(self._fila)
            self._fila = None
        elif tag == "table" and self._tabla is not None:
            self.tablas.append(self._tabla)
            self._tabla = None

    def handle_data(self, data):
        if self._ignorar:
            return
        if self._en_titular:
            self._buf_titular.append(data)
        if self._celda is not None:
            self._celda.append(data)


def horas(texto):
    """Devuelve [(inicio, fin)] con formato HH:MM para cada franja que aparezca en la celda."""
    out = []
    for h1, m1, h2, m2 in RE_HORAS.findall(texto):
        if int(h1) < 24 and int(h2) < 24 and int(m1) < 60 and int(m2) < 60:
            out.append((f"{int(h1):02d}:{m1}", f"{int(h2):02d}:{m2}"))
    return out


def extraer_cortes(html):
    """Lee las tablas de suministro doméstico (las que tienen columna 'Localidad')."""
    lector = LectorTablas()
    lector.feed(html)
    cortes = {}
    for tabla in lector.tablas:
        filas = tabla["filas"]
        if not filas:
            continue
        cab = [slug(c) for c in filas[0]]
        if "municipio" not in cab or "localidad" not in cab:
            continue  # p. ej. la tabla agrícola usa 'Zona' y 'Tipo de agua'
        i_mun, i_loc = cab.index("municipio"), cab.index("localidad")
        columnas_dia = {i: int(RE_DIA_COL.match(c).group(1)) for i, c in enumerate(filas[0]) if RE_DIA_COL.match(c)}

        if columnas_dia:  # formato mensual: una columna por día
            m = RE_MES_ANIO.search(tabla["titular"])
            if not m:
                continue
            mes, anio = MESES[m.group(1).lower()], int(m.group(2))
            for fila in filas[1:]:
                if len(fila) <= max(i_mun, i_loc):
                    continue
                for i, dia in columnas_dia.items():
                    if i >= len(fila):
                        continue
                    for ini, fin in horas(fila[i]):
                        try:
                            fecha = dt.date(anio, mes, dia).isoformat()
                        except ValueError:
                            continue
                        _anotar(cortes, fecha, fila[i_mun], fila[i_loc], ini, fin)
        else:  # formato lista: una fila por corte, con la fecha escrita
            for fila in filas[1:]:
                if len(fila) <= max(i_mun, i_loc):
                    continue
                fecha, franjas = None, []
                for celda in fila:
                    f = RE_FECHA.search(celda)
                    if f and not fecha:
                        try:
                            fecha = dt.date(int(f.group(3)), MESES[f.group(2).lower()], int(f.group(1))).isoformat()
                        except ValueError:
                            pass
                    elif not franjas:
                        franjas = horas(celda)
                if fecha:  # sin horario escrito no se anota: no se suponen horas
                    for ini, fin in franjas:
                        _anotar(cortes, fecha, fila[i_mun], fila[i_loc], ini, fin)
    return sorted(cortes.values(), key=lambda c: (c["fecha"], c["municipio"], c["nombre"], c["inicio"]))


def _anotar(cortes, fecha, municipio, nombre, ini, fin):
    municipio, nombre = municipio.strip(), nombre.strip()
    if not nombre or not municipio:
        return
    clave = (fecha, slug(nombre), ini, fin)
    cortes.setdefault(clave, {"fecha": fecha, "municipio": municipio, "nombre": nombre, "inicio": ini, "fin": fin})


def resolver_localidades(cortes, catalogo):
    """Cambia el nombre oficial por el id de la lista cerrada. Añade al catálogo los nombres nuevos."""
    por_slug = {}
    for loc in catalogo["localidades"]:
        por_slug[slug(loc["nombre"])] = loc["id"]
        por_slug[loc["id"]] = loc["id"]
        for a in loc.get("alias", []):
            por_slug.setdefault(slug(a), loc["id"])
    nuevas = []
    for c in cortes:
        s = slug(c["nombre"])
        if s not in por_slug:
            catalogo["localidades"].append({"id": s, "nombre": c["nombre"], "municipio": c["municipio"],
                                           "lat": None, "lon": None, "alias": []})
            por_slug[s] = s
            nuevas.append(c["nombre"])
        c["localidad"] = por_slug[s]
        del c["nombre"]
    return nuevas


def fusionar(viejo, leidos, hoy):
    """Los días pasados se conservan como se leyeron; de hoy en adelante manda la última lectura."""
    if not viejo or not viejo.get("completo"):
        return leidos
    previos = viejo.get("cortes", [])
    meses_leidos = {c["fecha"][:7] for c in leidos}
    meses_previos = {c["fecha"][:7] for c in previos}
    hoy_iso = hoy.isoformat()
    out = {}
    for c in previos:
        if c["fecha"][:7] not in meses_leidos or c["fecha"] < hoy_iso:
            out[(c["fecha"], c["localidad"], c["inicio"], c["fin"])] = c
    for c in leidos:
        if c["fecha"] >= hoy_iso or c["fecha"][:7] not in meses_previos:
            out[(c["fecha"], c["localidad"], c["inicio"], c["fin"])] = c
    return sorted(out.values(), key=lambda c: (c["fecha"], c["municipio"], c["localidad"], c["inicio"]))


def descargar():
    robots = urllib.robotparser.RobotFileParser()
    robots.set_url("https://aguasdelanzaroteylagraciosa.com/robots.txt")
    try:
        robots.read()
    except Exception as e:  # sin robots.txt legible no hay prohibición expresa; seguimos
        print(f"Aviso: no se pudo leer robots.txt ({e}).", file=sys.stderr)
    else:
        if not robots.can_fetch(AGENTE, URL):
            sys.exit("El robots.txt de la web oficial no permite esta lectura automática. "
                     "Guarda la página a mano y usa --archivo.")
    pet = urllib.request.Request(URL, headers={"User-Agent": AGENTE, "Accept-Language": "es"})
    with urllib.request.urlopen(pet, timeout=40) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--archivo", help="página guardada a mano (HTML) en lugar de leer la web")
    ap.add_argument("--salida", default=str(F_CALENDARIO))
    ap.add_argument("--localidades", default=str(F_LOCALIDADES))
    ap.add_argument("--hoy", help="AAAA-MM-DD, solo para pruebas")
    a = ap.parse_args()

    html = Path(a.archivo).read_text(encoding="utf-8", errors="replace") if a.archivo else descargar()
    cortes = extraer_cortes(html)
    if not cortes:
        sys.exit("No se ha encontrado ningún corte en la página. Puede que haya cambiado de formato. "
                 "No se modifican los datos.")

    catalogo = json.loads(Path(a.localidades).read_text(encoding="utf-8"))
    nuevas = resolver_localidades(cortes, catalogo)
    hoy = dt.date.fromisoformat(a.hoy) if a.hoy else dt.datetime.now(CANARIAS).date()
    salida = Path(a.salida)
    viejo = json.loads(salida.read_text(encoding="utf-8")) if salida.exists() else None
    todos = fusionar(viejo, cortes, hoy)

    datos = {
        "fuente": URL,
        "leido": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "completo": True,
        "nota": "",
        "cortes": todos,
    }
    salida.write_text(json.dumps(datos, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if nuevas:
        Path(a.localidades).write_text(json.dumps(catalogo, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("Localidades nuevas, sin punto en el mapa hasta que se les pongan coordenadas: " + ", ".join(sorted(set(nuevas))))
    print(f"{len(cortes)} cortes leídos; {len(todos)} en el registro.")


if __name__ == "__main__":
    main()
