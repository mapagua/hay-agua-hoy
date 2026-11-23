// Servidor de avisos vecinales. Cloudflare Worker + base de datos D1.
//
// Qué guarda: pueblo, estado (sin agua / poca presión / con agua) y la hora redondeada a 10 minutos.
// Qué no guarda: IP, nombre, texto libre, fotos, ubicación exacta.
// Para no contar dos veces a la misma persona guarda, como mucho dos días, una huella de un solo
// sentido de la conexión (HMAC con la clave SAL). Pasado ese plazo la huella se borra.
//
// Configuración (panel de Cloudflare → Settings → Variables and Secrets / Bindings):
//   DB      enlace a la base de datos D1 (obligatorio)
//   SAL     secreto, una frase larga al azar (obligatorio)
//   ORIGEN  dirección de la página, p. ej. https://ejemplo.github.io (recomendado)
//   SITIO   dirección completa de la página, para leer de ella la lista de pueblos (opcional)

const VENTANA_S = 6 * 3600;      // "ahora" son las últimas 6 horas
const UMBRAL = 3;                // vecinos distintos para dar un aviso por contrastado
const ESPERA_S = 30 * 60;        // una misma conexión puede avisar del mismo pueblo cada 30 min
const MAX_DIA_CONEXION = 8;      // avisos por conexión y día, entre todos los pueblos
const MAX_HORA_TOTAL = 600;      // freno general contra avalanchas
const DIAS_HUELLA = 2;           // días que vive la huella de la conexión
const ESTADOS = new Set(["sin", "poca", "con"]);

// Lista cerrada de pueblos. Si SITIO está configurado se usa la de datos/localidades.json.
const LOCALIDADES_BASE = [/*LISTA*/"arrecife","argana-alta","haria","maguez","arrieta","punta-mujeres","mala","orzola","ye","guinate","tabayesco","charco-del-palo","villa-de-teguise","tahiche","nazaret","tao","tiagua","soo","munique","guatiza","los-valles","el-mojon","teseguite","mozaga","caleta-de-famara","costa-teguise","caleta-de-sebo","san-bartolome","guime","el-islote-tomaren","montana-blanca","playa-honda","tinajo-casco","el-cuchillo","la-santa","mancha-blanca","la-vegueta","tias-pueblo","macher","la-asomada","conil","masdache","tegoyo","puerto-del-carmen","yaiza","uga","femes","las-brenas","el-golfo","puerto-calero","playa-quemada","playa-blanca"/*FIN*/];

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
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}
const responder = (env, estado, cuerpo, extra) => new Response(JSON.stringify(cuerpo), { status: estado, headers: cabeceras(env, extra) });

// Cierra los días ya pasados: guarda cuántos vecinos distintos avisaron y borra las huellas.
async function cerrarDias(env, hoyMs) {
  const limite = fechaCanaria(hoyMs - DIAS_HUELLA * 86400e3);
  const pendiente = await env.DB.prepare("SELECT 1 AS x FROM avisos WHERE huella IS NOT NULL AND fecha < ? LIMIT 1").bind(limite).first();
  if (!pendiente) return;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO dias (fecha, localidad, vecinos_sin, avisos_sin, avisos_poca, avisos_con)
       SELECT fecha, localidad,
              COUNT(DISTINCT CASE WHEN estado = 'sin' THEN huella END),
              SUM(estado = 'sin'), SUM(estado = 'poca'), SUM(estado = 'con')
       FROM avisos WHERE huella IS NOT NULL AND fecha < ? GROUP BY fecha, localidad`
    ).bind(limite),
    env.DB.prepare("UPDATE avisos SET huella = NULL WHERE huella IS NOT NULL AND fecha < ?").bind(limite),
  ]);
}

async function recibirAviso(request, env) {
  if (Number(request.headers.get("Content-Length") || 0) > 300) return responder(env, 413, { error: "demasiado-grande" });
  let dato;
  try { dato = JSON.parse((await request.text()).slice(0, 300)); } catch (e) { return responder(env, 400, { error: "formato" }); }
  const localidad = dato && typeof dato.localidad === "string" ? dato.localidad : "";
  const estado = dato && typeof dato.estado === "string" ? dato.estado : "";
  if (!ESTADOS.has(estado) || !(await localidades(env)).has(localidad)) return responder(env, 400, { error: "datos" });

  const ms = Date.now();
  const ahora = Math.floor(ms / 1000);
  const fecha = fechaCanaria(ms);
  const ip = red(request.headers.get("CF-Connecting-IP") || "desconocida");

  await env.DB.prepare("DELETE FROM limites WHERE caduca < ?").bind(ahora).run();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM avisos WHERE ts > ?").bind(ahora - 3600).first();
  if (total.n >= MAX_HORA_TOTAL) return responder(env, 429, { error: "saturado" });

  const kPueblo = "p:" + (await huella(env.SAL, `p|${ip}|${localidad}`));
  const kDia = "d:" + (await huella(env.SAL, `d|${ip}|${fecha}`));
  const reciente = await env.DB.prepare("SELECT 1 AS x FROM limites WHERE clave = ?").bind(kPueblo).first();
  if (reciente) return responder(env, 429, { error: "reciente", espera_min: ESPERA_S / 60 });
  const dia = await env.DB.prepare("SELECT cuenta FROM limites WHERE clave = ?").bind(kDia).first();
  if (dia && dia.cuenta >= MAX_DIA_CONEXION) return responder(env, 429, { error: "limite-diario" });

  const vecino = await huella(env.SAL, `v|${ip}|${localidad}`);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO avisos (ts, fecha, localidad, estado, huella) VALUES (?, ?, ?, ?, ?)").bind(ahora - (ahora % 600), fecha, localidad, estado, vecino),
    env.DB.prepare("INSERT OR REPLACE INTO limites (clave, caduca, cuenta) VALUES (?, ?, 1)").bind(kPueblo, ahora + ESPERA_S),
    env.DB.prepare("INSERT INTO limites (clave, caduca, cuenta) VALUES (?, ?, 1) ON CONFLICT(clave) DO UPDATE SET cuenta = cuenta + 1").bind(kDia, ahora + 86400),
  ]);
  return responder(env, 201, { ok: true });
}

async function estado(env) {
  const ms = Date.now();
  const ahora = Math.floor(ms / 1000);
  await cerrarDias(env, ms);

  // Ahora: lo último que ha dicho cada vecino en las últimas 6 horas.
  const filas = (await env.DB.prepare(
    "SELECT localidad, estado, huella FROM avisos WHERE ts > ? AND huella IS NOT NULL ORDER BY ts ASC, id ASC"
  ).bind(ahora - VENTANA_S).all()).results;
  const ultimo = new Map();
  for (const f of filas) ultimo.set(f.localidad + "|" + f.huella, f);
  const ahoraPorPueblo = {};
  for (const f of ultimo.values()) {
    const p = (ahoraPorPueblo[f.localidad] ||= { sin: 0, poca: 0, con: 0 });
    p[f.estado] += 1;
  }

  // Días con tres o más vecinos distintos sin agua: los ya cerrados y los que siguen abiertos.
  const cerrados = (await env.DB.prepare("SELECT fecha, localidad, vecinos_sin AS vecinos FROM dias WHERE vecinos_sin >= ? ORDER BY fecha").bind(UMBRAL).all()).results;
  const abiertos = (await env.DB.prepare(
    `SELECT fecha, localidad, COUNT(DISTINCT huella) AS vecinos FROM avisos
     WHERE huella IS NOT NULL AND estado = 'sin' GROUP BY fecha, localidad HAVING vecinos >= ? ORDER BY fecha`
  ).bind(UMBRAL).all()).results;
  const vistos = new Set(cerrados.map((d) => d.fecha + "|" + d.localidad));
  const dias = cerrados.concat(abiertos.filter((d) => !vistos.has(d.fecha + "|" + d.localidad)));
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
      if (request.method === "POST" && ruta === "/aviso") return await recibirAviso(request, env);
      if (request.method === "GET" && ruta === "/estado") return await estado(env);
      return responder(env, 404, { error: "no-existe" });
    } catch (e) {
      return responder(env, 500, { error: "interno" });
    }
  },
};
