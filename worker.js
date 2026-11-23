// Servidor de avisos vecinales y buzón de opiniones. Cloudflare Worker + base de datos D1.
//
// Avisos. Guarda: pueblo, estado (sin agua / poca presión / con agua) y la hora redondeada a 10 minutos.
// No guarda: IP, nombre, texto libre, fotos ni ubicación.
// Para contar a cada vecino una sola vez guarda, durante dos días como máximo, dos huellas de un solo
// sentido (HMAC con la clave SAL): una de la conexión y otra de un número al azar que genera el móvil.
// Dos avisos que comparten conexión o móvil cuentan como el mismo vecino. Pasados dos días se borran
// las huellas y solo queda el recuento del día.
//
// Opiniones. Guarda: fecha, tipo y texto (máximo 1000 caracteres). No guarda la IP. Se borran al año.
// Para leerlas: consola de D1 → SELECT * FROM opiniones ORDER BY id DESC;
//
// Configuración (panel de Cloudflare → Settings → Variables and Secrets / Bindings):
//   DB      enlace a la base de datos D1 (obligatorio)
//   SAL     secreto, una frase larga al azar (obligatorio)
//   ORIGEN  dirección de la página sin barra final, p. ej. https://usuario.github.io (obligatorio en producción)
//   SITIO   dirección completa de la página, para leer de ella la lista de pueblos (opcional)

const VENTANA_S = 6 * 3600;      // "ahora" son las últimas 6 horas
const UMBRAL = 3;                // vecinos distintos para que un aviso cuente
const ESPERA_S = 30 * 60;        // una misma conexión o móvil puede avisar del mismo pueblo cada 30 min
const MAX_DIA_CONEXION = 8;      // pueblos por conexión y día (una wifi compartida, un bar)
const MAX_PUEBLOS_MOVIL = 2;     // pueblos por móvil y día: el tuyo y, como mucho, el de un familiar
const MAX_HORA_TOTAL = 600;      // freno general contra avalanchas
const DIAS_HUELLA = 2;           // días que viven las huellas (cubre los avisos de anteayer)
const MAX_DIAS_ATRAS = 2;        // se puede avisar desde ayer o desde anteayer
const PAIS = "ES";               // los avisos desde otro país se guardan, pero no cuentan
const ESTADOS = new Set(["sin", "poca", "con"]);
const TIPOS_OPINION = new Set(["error", "pueblo", "idea", "otro"]);
const MAX_OPINIONES_DIA = 5;     // mensajes por conexión y día
const DIAS_OPINION = 365;        // los mensajes se borran al año

// Lista cerrada de pueblos. Si SITIO está configurado se usa la de datos/localidades.json.
const LOCALIDADES_BASE = [/*LISTA*/"arrecife","argana-alta","haria","maguez","arrieta","punta-mujeres","mala","orzola","ye","guinate","tabayesco","charco-del-palo","villa-de-teguise","tahiche","nazaret","tao","tiagua","soo","munique","guatiza","los-valles","el-mojon","teseguite","mozaga","caleta-de-famara","costa-teguise","caleta-de-sebo","san-bartolome","guime","el-islote-tomaren","montana-blanca","playa-honda","tinajo-casco","el-cuchillo","la-santa","mancha-blanca","la-vegueta","tias-pueblo","macher","la-asomada","conil","masdache","tegoyo","puerto-del-carmen","yaiza","uga","femes","las-brenas","el-golfo","puerto-calero","playa-quemada","playa-blanca","los-cocoteros","zonas-altas-de-puerto-del-carmen","barranco-de-las-truchas","pedro-barba","las-nieves","caleta-caballo","tajaste","tinguaton","la-costa","los-roferos","la-degollada","las-casitas-de-femes","maciot","la-hoya","temuime"/*FIN*/];

let listaCache = { ids: new Set(LOCALIDADES_BASE), leida: 0 };

async function localidades(env) {
  const ahora = Date.now();
  if (env.SITIO && ahora - listaCache.leida > 3600e3) {
    listaCache.leida = ahora; // aunque falle, no reintentar hasta dentro de una hora
    try {
      const r = await fetch(new URL("datos/localidades.json", env.SITIO.replace(/\/?$/, "/")));
      if (r.ok) {
        const ids = (await r.json()).localidades.map((l) => l.id).filter((id) => /^[a-z0-9-]{1,60}$/.test(id));
        if (ids.length >= 10 && ids.length <= 500) listaCache.ids = new Set([...LOCALIDADES_BASE, ...ids]);
      }
    } catch (e) { /* se sigue con la lista anterior */ }
  }
  return listaCache.ids;
}

const fmtFecha = new Intl.DateTimeFormat("en-CA", { timeZone: "Atlantic/Canary", year: "numeric", month: "2-digit", day: "2-digit" });
const fechaCanaria = (ms) => fmtFecha.format(new Date(ms));

async function huella(sal, texto) {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(sal), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(texto));
  return [...new Uint8Array(firma)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// En IPv6 una sola casa tiene millones de direcciones: se usa solo la red (los primeros 64 bits).
function red(ip) {
  if (!ip.includes(":")) return ip;
  const [izq, der = ""] = ip.toLowerCase().split("::");
  const a = izq ? izq.split(":") : [];
  const b = der ? der.split(":") : [];
  const completa = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return completa.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function cabeceras(env, extra) {
  return {
    "Access-Control-Allow-Origin": env.ORIGEN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}
const responder = (env, estado, cuerpo, extra) => new Response(JSON.stringify(cuerpo), { status: estado, headers: cabeceras(env, extra) });

async function leerJSON(request, max) {
  if (Number(request.headers.get("Content-Length") || 0) > max) return { error: "demasiado-grande" };
  const texto = await request.text();
  if (texto.length > max) return { error: "demasiado-grande" };
  try { const d = JSON.parse(texto); return d && typeof d === "object" ? { dato: d } : { error: "formato" }; } catch (e) { return { error: "formato" }; }
}

// Junta los avisos en vecinos: dos avisos son del mismo vecino si comparten conexión o móvil.
// Las filas llegan ordenadas por hora; el estado de cada vecino es el de su último aviso.
function agrupar(filas) {
  const padre = [];
  const raiz = (i) => (padre[i] === i ? i : (padre[i] = raiz(padre[i])));
  const vistos = [new Map(), new Map()];
  filas.forEach((f, i) => {
    padre[i] = i;
    [f.huella, f.movil].forEach((clave, k) => {
      if (!clave) return;
      if (vistos[k].has(clave)) padre[raiz(i)] = raiz(vistos[k].get(clave)); else vistos[k].set(clave, i);
    });
  });
  const vecinos = new Map();
  filas.forEach((f, i) => {
    const r = raiz(i);
    const v = vecinos.get(r) || { estado: f.estado, sin: false };
    v.estado = f.estado;
    if (f.estado === "sin") v.sin = true;
    vecinos.set(r, v);
  });
  return [...vecinos.values()];
}
function porGrupo(filas, clave) {
  const g = new Map();
  for (const f of filas) { const k = clave(f); if (!g.has(k)) g.set(k, []); g.get(k).push(f); }
  return g;
}

// Cierra los días ya pasados: guarda cuántos vecinos distintos avisaron y borra las huellas.
async function cerrarDias(env, hoyMs) {
  const limite = fechaCanaria(hoyMs - DIAS_HUELLA * 86400e3);
  const filas = (await env.DB.prepare(
    "SELECT fecha, localidad, estado, huella, movil, cuenta FROM avisos WHERE huella IS NOT NULL AND fecha < ? ORDER BY ts ASC, id ASC"
  ).bind(limite).all()).results;
  if (!filas.length) return;
  const ops = [];
  for (const [k, grupo] of porGrupo(filas, (f) => f.fecha + "|" + f.localidad)) {
    const [fecha, localidad] = k.split("|");
    const validos = grupo.filter((f) => f.cuenta);
    const vecinosSin = agrupar(validos).filter((v) => v.sin).length;
    const n = (e) => grupo.filter((f) => f.estado === e).length;
    ops.push(env.DB.prepare("INSERT OR REPLACE INTO dias (fecha, localidad, vecinos_sin, avisos_sin, avisos_poca, avisos_con) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(fecha, localidad, vecinosSin, n("sin"), n("poca"), n("con")));
  }
  ops.push(env.DB.prepare("UPDATE avisos SET huella = NULL, movil = NULL WHERE huella IS NOT NULL AND fecha < ?").bind(limite));
  await env.DB.batch(ops);
}

async function recibirAviso(request, env) {
  const { dato, error } = await leerJSON(request, 400);
  if (error) return responder(env, error === "demasiado-grande" ? 413 : 400, { error });
  const localidad = typeof dato.localidad === "string" ? dato.localidad : "";
  const estado = typeof dato.estado === "string" ? dato.estado : "";
  const movil = typeof dato.movil === "string" ? dato.movil : "";
  // "dias": 0 = solo hoy, 1 = desde ayer, 2 = desde anteayer. Solo vale para "sin" y "poca".
  const dias = dato.dias !== undefined ? dato.dias : 0;
  if (!ESTADOS.has(estado) || !/^[0-9a-f]{32}$/.test(movil) || !(await localidades(env)).has(localidad)) return responder(env, 400, { error: "datos" });
  if (!Number.isInteger(dias) || dias < 0 || dias > MAX_DIAS_ATRAS || (estado === "con" && dias !== 0)) return responder(env, 400, { error: "datos" });

  const ms = Date.now();
  const ahora = Math.floor(ms / 1000);
  const fecha = fechaCanaria(ms);
  const ip = red(request.headers.get("CF-Connecting-IP") || "desconocida");
  const pais = request.cf && request.cf.country;
  const cuenta = !pais || pais === PAIS ? 1 : 0;

  await env.DB.prepare("DELETE FROM limites WHERE caduca < ?").bind(ahora).run();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM avisos WHERE ts > ?").bind(ahora - 3600).first();
  if (total.n >= MAX_HORA_TOTAL) return responder(env, 429, { error: "saturado" });

  const [kRedPueblo, kRedDia, kMovilPueblo, kMovilDiaPueblo, kMovilDia] = await Promise.all([
    huella(env.SAL, `p|${ip}|${localidad}`), huella(env.SAL, `d|${ip}|${fecha}`),
    huella(env.SAL, `mp|${movil}|${localidad}`), huella(env.SAL, `mdp|${movil}|${fecha}|${localidad}`), huella(env.SAL, `md|${movil}|${fecha}`),
  ]).then((h) => ["p:", "d:", "mp:", "mdp:", "md:"].map((pre, i) => pre + h[i]));
  const leer = async (clave) => env.DB.prepare("SELECT cuenta FROM limites WHERE clave = ?").bind(clave).first();
  if ((await leer(kRedPueblo)) || (await leer(kMovilPueblo))) return responder(env, 429, { error: "reciente", espera_min: ESPERA_S / 60 });
  const redDia = await leer(kRedDia);
  if (redDia && redDia.cuenta >= MAX_DIA_CONEXION) return responder(env, 429, { error: "limite-diario" });
  const yaEstePueblo = await leer(kMovilDiaPueblo);
  const movilDia = await leer(kMovilDia);
  if (!yaEstePueblo && movilDia && movilDia.cuenta >= MAX_PUEBLOS_MOVIL) return responder(env, 429, { error: "limite-pueblos" });

  const [hRed, hMovil] = await Promise.all([huella(env.SAL, `v|${ip}|${localidad}`), huella(env.SAL, `m|${movil}|${localidad}`)]);
  const ops = [];
  for (let k = 0; k <= dias; k++) { // los días anteriores quedan fuera de "ahora" porque su hora es de hace 24 o 48 horas
    const t = ahora - k * 86400;
    ops.push(env.DB.prepare("INSERT INTO avisos (ts, fecha, localidad, estado, huella, movil, cuenta) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(t - (t % 600), fechaCanaria(t * 1000), localidad, estado, hRed, hMovil, cuenta));
  }
  const fija = (clave, segundos) => env.DB.prepare("INSERT OR REPLACE INTO limites (clave, caduca, cuenta) VALUES (?, ?, 1)").bind(clave, ahora + segundos);
  const suma = (clave) => env.DB.prepare("INSERT INTO limites (clave, caduca, cuenta) VALUES (?, ?, 1) ON CONFLICT(clave) DO UPDATE SET cuenta = cuenta + 1").bind(clave, ahora + 86400);
  ops.push(fija(kRedPueblo, ESPERA_S), fija(kMovilPueblo, ESPERA_S), suma(kRedDia));
  if (!yaEstePueblo) ops.push(fija(kMovilDiaPueblo, 86400), suma(kMovilDia));
  await env.DB.batch(ops);
  return responder(env, 201, { ok: true, cuenta: Boolean(cuenta) });
}

async function recibirOpinion(request, env) {
  const { dato, error } = await leerJSON(request, 4000);
  if (error) return responder(env, error === "demasiado-grande" ? 413 : 400, { error });
  const tipo = typeof dato.tipo === "string" ? dato.tipo : "";
  const texto = typeof dato.texto === "string" ? dato.texto.replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028-\u202E]/g, "").trim() : "";
  if (!TIPOS_OPINION.has(tipo) || texto.length < 3 || texto.length > 1000) return responder(env, 400, { error: "datos" });

  const ms = Date.now();
  const ahora = Math.floor(ms / 1000);
  const fecha = fechaCanaria(ms);
  const ip = red(request.headers.get("CF-Connecting-IP") || "desconocida");
  await env.DB.prepare("DELETE FROM limites WHERE caduca < ?").bind(ahora).run();
  const kOp = "o:" + (await huella(env.SAL, `o|${ip}|${fecha}`));
  const usadas = await env.DB.prepare("SELECT cuenta FROM limites WHERE clave = ?").bind(kOp).first();
  if (usadas && usadas.cuenta >= MAX_OPINIONES_DIA) return responder(env, 429, { error: "limite-diario" });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO opiniones (fecha, tipo, texto) VALUES (?, ?, ?)").bind(fecha, tipo, texto),
    env.DB.prepare("INSERT INTO limites (clave, caduca, cuenta) VALUES (?, ?, 1) ON CONFLICT(clave) DO UPDATE SET cuenta = cuenta + 1").bind(kOp, ahora + 86400),
    env.DB.prepare("DELETE FROM opiniones WHERE fecha < ?").bind(fechaCanaria(ms - DIAS_OPINION * 86400e3)),
  ]);
  return responder(env, 201, { ok: true });
}

async function estado(env) {
  const ms = Date.now();
  const ahora = Math.floor(ms / 1000);
  await cerrarDias(env, ms);

  const abiertas = (await env.DB.prepare(
    "SELECT ts, fecha, localidad, estado, huella, movil FROM avisos WHERE huella IS NOT NULL AND cuenta = 1 ORDER BY ts ASC, id ASC"
  ).all()).results;

  // Ahora: lo último que ha dicho cada vecino en las últimas 6 horas.
  const ahoraPorPueblo = {};
  for (const [localidad, filas] of porGrupo(abiertas.filter((f) => f.ts > ahora - VENTANA_S), (f) => f.localidad)) {
    const p = (ahoraPorPueblo[localidad] = { sin: 0, poca: 0, con: 0 });
    for (const v of agrupar(filas)) p[v.estado] += 1;
  }

  // Días con tres o más vecinos distintos sin agua: los ya cerrados y los que siguen abiertos.
  const cerrados = (await env.DB.prepare("SELECT fecha, localidad, vecinos_sin AS vecinos FROM dias WHERE vecinos_sin >= ? ORDER BY fecha").bind(UMBRAL).all()).results;
  const vistos = new Set(cerrados.map((d) => d.fecha + "|" + d.localidad));
  const dias = [...cerrados];
  for (const [k, filas] of porGrupo(abiertas, (f) => f.fecha + "|" + f.localidad)) {
    if (vistos.has(k)) continue;
    const vecinos = agrupar(filas).filter((v) => v.sin).length;
    if (vecinos >= UMBRAL) { const [fecha, localidad] = k.split("|"); dias.push({ fecha, localidad, vecinos }); }
  }
  dias.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.localidad.localeCompare(b.localidad));
  const primero = await env.DB.prepare("SELECT MIN(fecha) AS f, COUNT(*) AS n FROM avisos").first();

  return responder(env, 200, {
    generado: new Date(ms).toISOString(),
    ventana_horas: VENTANA_S / 3600,
    umbral: UMBRAL,
    ahora: ahoraPorPueblo,
    dias,
    desde: primero.f,
    avisos_totales: primero.n,
  }, { "Cache-Control": "public, max-age=60" });
}

export default {
  async fetch(request, env) {
    try {
      const ruta = new URL(request.url).pathname.replace(/\/+$/, "");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cabeceras(env) });
      if (!env.DB || !env.SAL || env.SAL.length < 16) return responder(env, 500, { error: "sin-configurar" });
      if (request.method === "POST") {
        // Solo se aceptan envíos hechos desde la propia página.
        if (env.ORIGEN && request.headers.get("Origin") !== env.ORIGEN) return responder(env, 403, { error: "origen" });
        if (ruta === "/aviso") return await recibirAviso(request, env);
        if (ruta === "/opinion") return await recibirOpinion(request, env);
      }
      if (request.method === "GET" && ruta === "/estado") return await estado(env);
      return responder(env, 404, { error: "no-existe" });
    } catch (e) {
      return responder(env, 500, { error: "interno" });
    }
  },
};
