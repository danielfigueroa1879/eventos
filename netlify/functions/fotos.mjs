// Netlify Function: fotos de ingreso en Cloudflare R2 (bucket PRIVADO).
//
// Las credenciales de R2 viven SOLO aquí, como variables de entorno de Netlify
// (Site configuration → Environment variables). Nunca llegan al navegador:
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME (por defecto "guardias")
//
// Las fotos NO pasan por esta función: solo entrega enlaces firmados y el navegador sube/descarga
// directo desde R2 (sin costo de descarga). Acciones (POST JSON a /.netlify/functions/fotos):
//   { accion: "subir",  evento_id, asistencia_id, tipo, tipoMini } -> enlaces PUT (foto + miniatura)
//   { accion: "ver",    paths: ["<evento>/<asistencia>.webp", ...] } -> { urls: {path: url}, vence }
//   { accion: "borrar", pin, paths: [...] } | { accion: "borrar", pin, prefijo: "<evento_id>" }
//      -> { borradas, fallidas: [...] }   (pin = PIN de administrador; sin él responde 401)
//
// CACHÉ: los enlaces de lectura se firman con una fecha FIJA por ventana de 6 días y duran 7 días.
// Así el mismo archivo tiene el MISMO enlace en cada recarga y en todos los equipos, y el navegador
// usa la copia que ya tiene en vez de volver a descargarla.

import crypto from "node:crypto";

// Datos PÚBLICOS de Supabase (los mismos que ya están en index.html), solo para comprobar que la
// asistencia existe antes de entregar un enlace de subida.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ixdpjkfkbndcijowynxn.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZHBqa2ZrYm5kY2lqb3d5bnhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTgxNTIsImV4cCI6MjEwNzMzNDE1Mn0.qeeELjWAkMcDviavQSvsC5IQvLB-iG-KkdpdH3OCHdI";

const VENTANA_S = 6 * 86400;       // la fecha de firma cambia cada 6 días
const VIGENCIA_S = 7 * 86400;      // máximo permitido por S3/R2 para un enlace firmado
const SUBIDA_S = 10 * 60;          // el enlace de subida dura 10 min
const CACHE_FOTO = "private, max-age=604800";
const TIPOS = ["image/webp", "image/jpeg", "image/png"];
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_UUID = new RegExp(`^${UUID}$`, "i");
const RE_RUTA = new RegExp(`^${UUID}/${UUID}(_t)?\\.webp$`, "i");

function config() {
  const id = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  let endpoint = (process.env.R2_ENDPOINT || "").trim().replace(/\/+$/, "");
  const bucket = (process.env.R2_BUCKET_NAME || "guardias").trim().toLowerCase();
  if (!id || !secret || !endpoint) return null;
  if (!/^https?:\/\//.test(endpoint)) endpoint = "https://" + endpoint;
  // Si el endpoint se copió con el bucket al final, se quita.
  if (endpoint.toLowerCase().endsWith("/" + bucket)) endpoint = endpoint.slice(0, -(bucket.length + 1));
  return { id, secret, endpoint, bucket, host: new URL(endpoint).host };
}

// ---- Firma AWS SigV4 por query string (enlace prefirmado), región "auto" de R2 ----
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s, "utf8").digest();
const sha256 = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const amzFecha = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function prefirmar(cfg, { metodo, clave = "", query = {}, headers = {}, fecha, expira }) {
  const amz = amzFecha(fecha), dia = amz.slice(0, 8);
  const alcance = `${dia}/auto/s3/aws4_request`;
  const hs = { host: cfg.host };
  for (const [k, v] of Object.entries(headers)) hs[k.toLowerCase()] = String(v).trim();
  const nombres = Object.keys(hs).sort();
  const firmados = nombres.join(";");
  const q = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.id}/${alcance}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expira),
    "X-Amz-SignedHeaders": firmados,
  };
  const qs = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join("&");
  const uri = "/" + [cfg.bucket, ...(clave ? clave.split("/") : [])].map(enc).join("/");
  const canon = [metodo, uri, qs, nombres.map(n => `${n}:${hs[n]}\n`).join(""), firmados, "UNSIGNED-PAYLOAD"].join("\n");
  const aFirmar = ["AWS4-HMAC-SHA256", amz, alcance, sha256(canon)].join("\n");
  let k = hmac("AWS4" + cfg.secret, dia);
  k = hmac(k, "auto"); k = hmac(k, "s3"); k = hmac(k, "aws4_request");
  const firma = crypto.createHmac("sha256", k).update(aFirmar, "utf8").digest("hex");
  return `${cfg.endpoint}${uri}?${qs}&X-Amz-Signature=${firma}`;
}

// Fecha de firma fija dentro de cada ventana: el enlace no cambia entre recargas.
function inicioVentana(ahora = Date.now()) {
  return new Date(Math.floor(ahora / 1000 / VENTANA_S) * VENTANA_S * 1000);
}

const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

// Estado de la asistencia para SUBIR: null si no existe; { conFoto, creadaMs } si existe.
// - Una asistencia que ya tiene foto no recibe enlace (nadie puede reemplazar una foto guardada).
// - "creada" es la hora del SERVIDOR de Supabase en que se creó la asistencia (columna agregada por
//   supabase-cierre.sql). Solo los ingresos recién hechos reciben enlace. Si la base aún no tiene esa
//   columna, se consulta sin ella y no se aplica el plazo.
const SUBIDA_PLAZO_MS = 3 * 60 * 60 * 1000;   // 3 h: con mala señal la foto se reenvía desde el teléfono más tarde
async function asistenciaParaSubir(evId, asisId) {
  const pedir = cols => fetch(`${SUPABASE_URL}/rest/v1/asistencias?select=${cols}&id=eq.${asisId}&evento_id=eq.${evId}&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  let r = await pedir("id,foto_url,creada");
  if (r.status === 400) r = await pedir("id,foto_url");   // base sin la columna "creada"
  if (!r.ok) throw new Error("supabase " + r.status);
  const d = await r.json();
  if (!Array.isArray(d) || !d.length) return null;
  const c = d[0].creada ? Date.parse(d[0].creada) : NaN;
  return { conFoto: !!d[0].foto_url, creadaMs: isNaN(c) ? null : c };
}

// Devuelve cuántas se borraron y cuáles fallaron (para que el panel no olvide su referencia).
async function borrarClaves(cfg, claves) {
  let n = 0;
  const fallidas = [];
  for (let i = 0; i < claves.length; i += 10) {
    await Promise.all(claves.slice(i, i + 10).map(async clave => {
      try {
        const url = prefirmar(cfg, { metodo: "DELETE", clave, fecha: new Date(), expira: 300 });
        const r = await fetch(url, { method: "DELETE" });
        if (r.ok || r.status === 404) n++; else fallidas.push(clave);
      } catch { fallidas.push(clave); }
    }));
  }
  return { n, fallidas };
}

// BORRAR exige el PIN de administrador, comprobado en Supabase (función verificar_clave: el PIN
// nunca se guarda aquí). Un PIN correcto se recuerda unos minutos en esta instancia para no
// consultar a Supabase en cada lote de borrado.
const PIN_OK_MS = 10 * 60 * 1000;
const pinesOk = new Map();   // sha256(pin) -> vence
async function pinAdminValido(pin) {
  if (typeof pin !== "string" || !pin || pin.length > 64) return false;
  const h = sha256("os10|" + pin), ahora = Date.now();
  if ((pinesOk.get(h) || 0) > ahora) return true;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verificar_clave`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_nombre: "admin", p_clave: pin }),
  });
  if (!r.ok) throw new Error("supabase " + r.status);
  const ok = (await r.json()) === true;
  if (ok) pinesOk.set(h, ahora + PIN_OK_MS);
  return ok;
}

async function listarPrefijo(cfg, prefijo) {
  const claves = [];
  let token = null;
  do {
    const query = { "list-type": "2", prefix: prefijo };
    if (token) query["continuation-token"] = token;
    const r = await fetch(prefirmar(cfg, { metodo: "GET", query, fecha: new Date(), expira: 300 }));
    if (!r.ok) throw new Error("listar " + r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) claves.push(m[1].replace(/&amp;/g, "&"));
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && t ? t[1] : null;
  } while (token);
  return claves;
}

export { prefirmar, inicioVentana };   // usadas en pruebas

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  const cfg = config();
  if (!cfg) return json({ error: "R2 no configurado en Netlify" }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  try {
    if (b.accion === "subir") {
      const ev = String(b.evento_id || ""), as = String(b.asistencia_id || "");
      if (!RE_UUID.test(ev) || !RE_UUID.test(as)) return json({ error: "ids inválidos" }, 400);
      const est = await asistenciaParaSubir(ev, as);
      if (!est) return json({ error: "asistencia no encontrada" }, 404);
      if (est.conFoto) return json({ error: "la asistencia ya tiene foto" }, 409);
      if (est.creadaMs != null && Date.now() - est.creadaMs > SUBIDA_PLAZO_MS) return json({ error: "plazo de subida vencido" }, 403);
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : "image/webp";
      const tipoMini = TIPOS.includes(b.tipoMini) ? b.tipoMini : "image/webp";
      const enlace = (clave, ct) => {
        const headers = { "content-type": ct, "cache-control": CACHE_FOTO };
        return { url: prefirmar(cfg, { metodo: "PUT", clave, headers, fecha: new Date(), expira: SUBIDA_S }), headers };
      };
      const clave = `${ev}/${as}.webp`;
      return json({ path: clave, foto: enlace(clave, tipo), mini: enlace(`${ev}/${as}_t.webp`, tipoMini) });
    }

    if (b.accion === "ver") {
      const paths = Array.isArray(b.paths) ? b.paths.slice(0, 300) : [];
      const fecha = inicioVentana();
      const urls = {};
      for (const p of paths) if (typeof p === "string" && RE_RUTA.test(p)) urls[p] = prefirmar(cfg, { metodo: "GET", clave: p, fecha, expira: VIGENCIA_S });
      return json({ urls, vence: fecha.getTime() + VIGENCIA_S * 1000 });
    }

    // Respaldo para el PDF/Excel con fotos: si el navegador no puede leer la imagen directo desde R2
    // (CORS), la función baja las miniaturas (~4 KB c/u) y las devuelve en base64. Solo se usa al
    // exportar y solo para las fotos que fallaron.
    if (b.accion === "bajar") {
      const paths = (Array.isArray(b.paths) ? b.paths.slice(0, 60) : []).filter(p => typeof p === "string" && RE_RUTA.test(p));
      const datos = {};
      await Promise.all(paths.map(async clave => {
        try {
          const r = await fetch(prefirmar(cfg, { metodo: "GET", clave, fecha: new Date(), expira: 300 }));
          if (!r.ok) return;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length && buf.length <= 300 * 1024) datos[clave] = { tipo: r.headers.get("content-type") || "image/webp", b64: buf.toString("base64") };
        } catch { /* foto no disponible */ }
      }));
      return json({ datos });
    }

    if (b.accion === "borrar") {
      if (!(await pinAdminValido(b.pin))) return json({ error: "no autorizado" }, 401);
      let claves = [];
      if (b.prefijo) {
        const pre = String(b.prefijo);
        if (!RE_UUID.test(pre)) return json({ error: "prefijo inválido" }, 400);
        claves = (await listarPrefijo(cfg, pre + "/")).filter(k => RE_RUTA.test(k));
      } else if (Array.isArray(b.paths)) {
        claves = b.paths.slice(0, 1000).filter(p => typeof p === "string" && RE_RUTA.test(p));
      }
      const { n, fallidas } = await borrarClaves(cfg, claves);
      return json({ borradas: n, fallidas });
    }

    return json({ error: "acción desconocida" }, 400);
  } catch (e) {
    console.error("fotos R2:", e && e.message);
    return json({ error: "error del servidor" }, 502);
  }
};
