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
//   { accion: "borrar", paths: [...] } | { accion: "borrar", prefijo: "<evento_id>" }
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

async function asistenciaExiste(evId, asisId) {
  const u = `${SUPABASE_URL}/rest/v1/asistencias?select=id&id=eq.${asisId}&evento_id=eq.${evId}&limit=1`;
  const r = await fetch(u, { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error("supabase " + r.status);
  const d = await r.json();
  return Array.isArray(d) && d.length > 0;
}

async function borrarClaves(cfg, claves) {
  let n = 0;
  for (let i = 0; i < claves.length; i += 10) {
    await Promise.all(claves.slice(i, i + 10).map(async clave => {
      const url = prefirmar(cfg, { metodo: "DELETE", clave, fecha: new Date(), expira: 300 });
      const r = await fetch(url, { method: "DELETE" });
      if (r.ok || r.status === 404) n++;
    }));
  }
  return n;
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
      if (!(await asistenciaExiste(ev, as))) return json({ error: "asistencia no encontrada" }, 404);
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

    if (b.accion === "borrar") {
      let claves = [];
      if (b.prefijo) {
        const pre = String(b.prefijo);
        if (!RE_UUID.test(pre)) return json({ error: "prefijo inválido" }, 400);
        claves = (await listarPrefijo(cfg, pre + "/")).filter(k => RE_RUTA.test(k));
      } else if (Array.isArray(b.paths)) {
        claves = b.paths.slice(0, 1000).filter(p => typeof p === "string" && RE_RUTA.test(p));
      }
      return json({ borradas: await borrarClaves(cfg, claves) });
    }

    return json({ error: "acción desconocida" }, 400);
  } catch (e) {
    console.error("fotos R2:", e && e.message);
    return json({ error: "error del servidor" }, 502);
  }
};
