# ¿Hay agua hoy?

Página que enseña los cortes de agua programados en Lanzarote y La Graciosa, pueblo a pueblo, con un mapa. Opcionalmente recoge avisos anónimos de vecinos sin agua.

## Qué hay en esta carpeta

| Archivo o carpeta | Para qué sirve |
|---|---|
| `index.html` | La página entera: textos, diseño y funcionamiento. No carga nada de otros sitios. |
| `datos/calendario.json` | Los cortes programados (julio a noviembre de 2026, sacados de los PDF oficiales). |
| `datos/localidades.json` | La lista de pueblos y dónde va cada punto en el mapa. |
| `datos/costa.json` | El contorno de Lanzarote y La Graciosa, trazado sobre la ortofoto de GRAFCAN. |
| `datos/isla.json` | Las cifras de «El agua de la isla», cada una con su fuente. |
| `fuentes/` | Las dos tipografías de la página (libres, licencia GUST). |
| `manifest.webmanifest`, `icono*.png`, `icono.svg` | Permiten añadir la página a la pantalla de inicio del móvil como si fuera una app. |
| `herramientas/actualizar_calendario.py` | Lee el calendario de la web oficial y actualiza `datos/`. |
| `herramientas/importar_pdf.py` | Carga el PDF mensual del calendario oficial. |
| `.github/workflows/actualizar.yml` | Hace que GitHub ejecute el lector de la web dos veces al día. |
| `servidor/` | El servidor de avisos de vecinos (opcional, para la fase 2). |

## Cómo se actualiza el calendario

### El lector de la web oficial

En la pestaña «Actions». Si sale un aviso, pulsa «I understand my workflows, go ahead and enable them». Después abre «Actualizar calendario» y pulsa «Run workflow».

- Si termina en verde, el calendario se actualizará solo cada día y no tendrás que cargar PDF.
- Si falla porque el `robots.txt` no deja leer la web, o porque no encuentra cortes, queda la vía del PDF.
- Si falla al guardar, ve a «Settings» → «Actions» → «General» → «Workflow permissions» y marca lectura y escritura.

### Si el lector no funciona: un PDF al mes

Al empezar cada mes, descarga de la web oficial el PDF «Calendario mensual de suspensiones programadas» y cárgalo:

- En un ordenador con Python: `pip install pdfplumber` y luego `python3 herramientas/importar_pdf.py el_archivo.pdf`. Sube a GitHub los archivos de `datos/` que cambien.
- Si no tienes Python a mano, cualquier persona con un ordenador puede hacerlo en cinco minutos.

Mientras falte el calendario del mes en curso, la página lo avisa arriba.

## Fase 2: avisos de vecinos

Sin esta parte la página funciona igual, solo con el calendario oficial. Conviene que alguien de confianza revise `servidor/worker.js` antes de activarla.

1. Crea una cuenta de Cloudflare.
2. Crea una base de datos D1 y pega `servidor/esquema.sql` en su consola.
3. Crea un Worker y pega `servidor/worker.js`.
4. En la configuración del Worker añade:
   - un enlace a la base de datos D1 llamado `DB`;
   - un secreto `SAL`: una frase larga al azar (30 caracteres o más) que no uses en ningún otro sitio;
   - una variable `ORIGEN` con la dirección de la página sin barra final, por ejemplo `https://usuario.github.io`;
   - una variable `SITIO` con la dirección completa, por ejemplo `https://usuario.github.io/repositorio/`.
5. En `index.html`, pon la dirección del Worker en `api: ""`.
6. No actives los registros («logs») del Worker: guardarían direcciones IP.

### Reglas de los avisos

- Tres respuestas posibles y un pueblo de una lista cerrada. No hay texto libre, fotos ni contacto.
- Quien no tiene agua puede decir desde cuándo: hoy, desde ayer o desde anteayer.
- Una misma conexión cuenta como un solo vecino por pueblo y día, avise las veces que avise.
- Con tres o más vecinos distintos, el aviso cuenta. Con menos, sale como «sin contrastar» y no entra en las cuentas.
- La dirección IP no se guarda nunca. La huella cifrada de la conexión se borra a los dos días.

Límite conocido: alguien con tres conexiones distintas (móvil, wifi y otra red) puede inventarse un aviso él solo. Las reglas lo frenan, no lo impiden.

## Estado: qué está probado y qué no

- La página está probada en navegador de móvil y de escritorio: mapa, pantalla completa, avisos de prueba, semana, letra grande.
- El servidor de avisos pasa 44 pruebas automáticas, pero no se ha ejecutado nunca en Cloudflare.
- El lector de la web oficial solo se ha probado con una página de ejemplo.
- El contorno de la isla tiene un error de posición de hasta 1 km. Los puntos de los pueblos están puestos a mano y son aproximados.
- Sin punto en el mapa: Barranco de las Truchas y Los Roferos.

## Licencia de los datos

- Calendario de cortes: publicado por el servicio de aguas en su web.
- Contorno de la isla: trazado sobre la ortofoto de IDECanarias (GRAFCAN). Fuente: Gobierno de Canarias. Licencia CC BY 3.0, que permite reutilizar y adaptar citando la fuente y sin dar a entender que el Gobierno de Canarias respalda el proyecto.
- Cifras de «El agua de la isla»: Centro de Datos del Cabildo de Lanzarote y las fuentes que se citan en `datos/isla.json` y en la propia página.
