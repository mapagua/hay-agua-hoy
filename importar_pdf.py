#!/usr/bin/env python3
"""Carga en datos/calendario.json los calendarios mensuales oficiales descargados en PDF.

Uso:
    pip install pdfplumber
    python3 herramientas/importar_pdf.py 2026_12_Calendario_mensual_de_suspensiones_programadas.pdf [otro.pdf ...]

Cada PDF es la «planificación original» de un mes. Los meses que se importan sustituyen por
completo a lo que hubiera de esos meses; los demás meses no se tocan.
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import actualizar_calendario as base  # noqa: E402


def leer_pdf(ruta):
    import pdfplumber
    cortes = {}
    with pdfplumber.open(ruta) as pdf:
        texto = "\n".join((p.extract_text() or "") for p in pdf.pages[:1])
        m = base.RE_MES_ANIO.search(texto)
        if not m:
            sys.exit(f"{ruta}: no se encuentra el mes y el año en la primera página.")
        mes, anio = base.MESES[m.group(1).lower()], int(m.group(2))
        for pagina in pdf.pages:
            for tabla in pagina.extract_tables():
                cab = next((f for f in tabla if f and base.slug(f[0] or "") == "municipio"), None)
                if not cab or base.slug(cab[1] or "") != "localidad":
                    continue
                dias = {i: int(base.RE_DIA_COL.match(c).group(1)) for i, c in enumerate(cab) if c and base.RE_DIA_COL.match(c)}
                for fila in tabla[tabla.index(cab) + 1:]:
                    if not fila or not (fila[0] or "").strip() or not (fila[1] or "").strip():
                        continue
                    municipio = " ".join(fila[0].split())
                    nombre = " ".join(fila[1].split())
                    for i, dia in dias.items():
                        celda = " ".join((fila[i] or "").split()) if i < len(fila) else ""
                        for ini, fin in base.horas(celda):
                            base._anotar(cortes, dt.date(anio, mes, dia).isoformat(), municipio, nombre, ini, fin)
    return f"{anio:04d}-{mes:02d}", sorted(cortes.values(), key=lambda c: (c["fecha"], c["municipio"], c["nombre"], c["inicio"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pdf", nargs="+")
    ap.add_argument("--salida", default=str(base.F_CALENDARIO))
    ap.add_argument("--localidades", default=str(base.F_LOCALIDADES))
    a = ap.parse_args()

    nuevos, meses = [], []
    for ruta in a.pdf:
        mes, cortes = leer_pdf(ruta)
        if not cortes:
            sys.exit(f"{ruta}: no se ha encontrado ningún corte. No se modifican los datos.")
        meses.append(mes)
        nuevos += cortes
        print(f"{mes}: {len(cortes)} cortes")

    catalogo = json.loads(Path(a.localidades).read_text(encoding="utf-8"))
    nuevas = base.resolver_localidades(nuevos, catalogo)
    salida = Path(a.salida)
    viejo = json.loads(salida.read_text(encoding="utf-8")) if salida.exists() else {}
    previos = [c for c in viejo.get("cortes", []) if viejo.get("completo") and c["fecha"][:7] not in meses]
    todos = sorted(previos + nuevos, key=lambda c: (c["fecha"], c["municipio"], c["localidad"], c["inicio"]))
    datos = {
        "fuente": base.URL,
        "leido": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "completo": True,
        "origen": "pdf",
        "nota": "Meses cargados desde el PDF oficial de planificación original: " + ", ".join(sorted(meses)) + ".",
        "cortes": todos,
    }
    salida.write_text(json.dumps(datos, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if nuevas:
        Path(a.localidades).write_text(json.dumps(catalogo, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("Localidades nuevas, sin punto en el mapa: " + ", ".join(sorted(set(nuevas))))
    print(f"{len(todos)} cortes en el registro.")


if __name__ == "__main__":
    main()
