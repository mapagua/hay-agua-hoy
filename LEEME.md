# ¿Hay agua hoy?

Página que enseña los cortes de agua programados en Lanzarote y La Graciosa, pueblo a pueblo, con un mapa. Opcionalmente recoge avisos anónimos de vecinos sin agua.

## Qué hay en esta carpeta

| Archivo o carpeta | Para qué sirve |
|---|---|
| `index.html` | La página entera: textos, diseño y funcionamiento. No carga nada de otros sitios. |
| `datos/calendario.json` | Los cortes programados. Se actualiza solo dos veces al día desde la web oficial. |
| `datos/localidades.json` | La lista de pueblos y dónde va cada punto en el mapa. |
| `datos/costa.json` | El contorno de Lanzarote y La Graciosa, trazado sobre la ortofoto de GRAFCAN. |
| `datos/isla.json` | Las cifras de «El agua de la isla», cada una con su fuente. |
| `manifest.webmanifest`, `icono*.png`, `icono.svg` | Permiten añadir la página a la pantalla de inicio del móvil como si fuera una app. |
| `herramientas/actualizar_calendario.py` | Lee el calendario de la web oficial y actualiza `datos/`. |
| `herramientas/importar_pdf.py` | Carga el PDF mensual del calendario oficial. |
| `.github/workflows/actualizar.yml` | Hace que GitHub ejecute el lector de la web dos veces al día. |

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

Sin esta parte la página funciona igual, solo con el calendario oficial.

El código del servidor (`worker.js` y `esquema.sql`) no está en este repositorio: se guarda aparte y solo se pega en Cloudflare. Cloudflare se usa con una cuenta propia del proyecto, que no se usa para nada más.

1. Crea una cuenta de Cloudflare.
2. Crea una base de datos D1 y pega `esquema.sql` en su consola.
3. Crea un Worker y pega `worker.js`.
4. En la configuración del Worker añade (sin `DB`, `SAL` y `ORIGEN` el servidor no funciona, a propósito):
   - un enlace a la base de datos D1 llamado `DB`;
   - un secreto `SAL`: una frase larga al azar, de 30 caracteres o más, que no uses en ningún otro sitio;
   - una variable `ORIGEN` con la dirección de la página sin barra final, por ejemplo `https://usuario.github.io`;
   - una variable `SITIO` con la dirección completa, por ejemplo `https://usuario.github.io/repositorio/`.
5. Tarea programada: Settings → Triggers → Cron Triggers → Add, escribe `0 * * * *` (cada hora en punto) y guarda. Es la que borra las huellas aunque nadie abra la página.
6. Registros: en Settings → Observability, comprueba que «Workers Logs» está desactivado. Si estuviera activo guardaría datos de cada petición, IP incluida.
7. En `index.html`:
   - pon la dirección del Worker en `api: ""`;
   - en la línea 7 (`Content-Security-Policy`), cambia `connect-src 'self';` por `connect-src 'self' https://LA-DIRECCION-DEL-WORKER;` con la dirección exacta.
8. Para ver las visitas: consola de D1 → `SELECT * FROM visitas ORDER BY fecha DESC LIMIT 30;`

### Reglas de los avisos

- Tres respuestas posibles y un pueblo de una lista cerrada. No hay texto libre, fotos ni contacto.
- Quien no tiene agua puede decir desde cuándo: hoy, desde ayer o desde anteayer.
- Una misma conexión cuenta como un solo vecino por pueblo y día, avise las veces que avise.
- Con tres o más vecinos distintos, el aviso cuenta. Con menos, sale como «sin contrastar» y no entra en las cuentas.
- La dirección IP no se guarda nunca. Las huellas cifradas de la conexión y del móvil se borran como mucho a los tres días.
- Los mensajes del buzón se borran a los 90 días.

Límite conocido: una sola persona puede fabricar varios «vecinos» poniendo y quitando el modo avión (cambia la IP) y borrando los datos del navegador (cambia el número del móvil). No tiene arreglo sin pedir datos a la gente. Por eso los avisos salen siempre como «sin comprobar» y no se mezclan con los cortes oficiales.

Con la fase 2 activa la página trata datos seudónimos (las huellas). El RGPD pide que el responsable de esos datos diga quién es: consultarlo antes de activarla (una asociación o una persona de confianza que figure como responsable).

## Estado: qué está probado y qué no

- La página está probada en navegador de móvil y de escritorio: mapa, pantalla completa, avisos de prueba, semana, letra grande.
- El servidor de avisos pasa 56 pruebas automáticas (con una base de datos que imita a D1), pero no se ha ejecutado nunca en Cloudflare.
- El lector de la web oficial solo se ha probado con una página de ejemplo.
- El contorno de la isla tiene un error de posición de hasta 1 km. Los puntos de los pueblos están puestos a mano y son aproximados.
- Sin punto en el mapa: Barranco de las Truchas y Los Roferos.

## Licencia de los datos

- Calendario de cortes: publicado por el servicio de aguas en su web.
- Contorno de la isla: trazado sobre la ortofoto de IDECanarias (GRAFCAN). Fuente: Gobierno de Canarias. Licencia CC BY 3.0, que permite reutilizar y adaptar citando la fuente y sin dar a entender que el Gobierno de Canarias respalda el proyecto.
- Cifras de «El agua de la isla»: Centro de Datos del Cabildo de Lanzarote y las fuentes que se citan en `datos/isla.json` y en la propia página.
