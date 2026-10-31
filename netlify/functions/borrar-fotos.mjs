// Netlify Scheduled Function: BORRADO AUTOMÁTICO de las fotos de ingreso y de los datos
// biométricos 12 h después de terminado cada evento.
//
// Se ejecuta sola cada hora (ver netlify.toml) y no se puede llamar desde internet.
// Usa las mismas variables de entorno de R2 que fotos.mjs (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_ENDPOINT, R2_BUCKET_NAME). Solo LEE Supabase (eventos e historial de partidos) con la clave pública.
//
// Cuándo "termina" un evento (hora de Chile):
//   - Evento con turnos: al terminar el último turno que empieza el último día (fecha_hasta o fecha_evento).
//   - Evento sin turnos / partido: a las 24:00 del último día.
//   - Partido cerrado y archivado: al momento del cierre (cerrado_at).
// Pasadas 12 h de ese término se borran de R2 la foto y su miniatura. Un evento sin fecha no se toca.
//
// BIOMETRÍA (requiere SUPABASE_SERVICE_ROLE_KEY, la misma de la función "biometria"): se borran la
// plantilla cifrada (guardias_biometria) y los intentos (biometria_intentos) de cada RUT que ya no
// tiene ingresos en ningún evento vigente (evento sin terminar, o terminado hace menos de 12 h).
// Si el guardia vuelve en otro evento, su primer ingreso crea una plantilla nueva.

import { prefirmar } from "./fotos.mjs";
import { normRut } from "./biometria/logica.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ixdpjkfkbndcijowynxn.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZHBqa2ZrYm5kY2lqb3d5bnhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTgxNTIsImV4cCI6MjEwNzMzNDE1Mn0.qeeELjWAkMcDviavQSvsC5IQvLB-iG-KkdpdH3OCHdI";

export const RETENCION_MS = 12 * 60 * 60 * 1000;   // 12 h después de terminado el evento
const ZONA = "America/Santiago";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_UUID = new RegExp(`^${UUID}$`, "i");
const RE_RUTA = new RegExp(`^${UUID}/${UUID}(_t)?\\.webp$`, "i");

function configR2() {
  const id = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  let endpoint = (process.env.R2_ENDPOINT || "").trim().replace(/\/+$/, "");
  const bucket = (process.env.R2_BUCKET_NAME || "guardias").trim().toLowerCase();
  if (!id || !secret || !endpoint) return null;
  if (!/^https?:\/\//.test(endpoint)) endpoint = "https://" + endpoint;
  if (endpoint.toLowerCase().endsWith("/" + bucket)) endpoint = endpoint.slice(0, -(bucket.length + 1));
  return { id, secret, endpoint, bucket, host: new URL(endpoint).host };
}

// Diferencia (ms) entre la hora de Chile y UTC en el instante `ms`.
function desfaseChile(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: ZONA, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// Instante UTC (ms) de una fecha "YYYY-MM-DD" + minutos desde las 00:00, en hora de Chile.
function instanteChile(fecha, minutos = 0) {
  const [y, m, d] = String(fecha).slice(0, 10).split("-").map(Number);
  const local = Date.UTC(y, m - 1, d) + minutos * 60000;
  let ms = local - desfaseChile(local);
  ms = local - desfaseChile(ms);   // segunda pasada por si cae en cambio de horario
  return ms;
}

// Momento en que termina el evento (ms UTC) o null si no tiene fecha.
export function finEvento(ev) {
  const dia = ev && (ev.fecha_hasta || ev.fecha_evento);
  if (!dia || !/^\d{4}-\d{2}-\d{2}/.test(String(dia))) return null;
  const conTurnos = ev.tipo !== "partido" && ev.usa_turnos !== false;
  if (!conTurnos) return instanteChile(dia, 24 * 60);
  let H = parseFloat(ev.turno_horas); if (!(H > 0)) H = 12; H = Math.min(24, Math.max(1, H));
  const m = String(ev.turno_inicio || "08:00").match(/^(\d{1,2}):(\d{2})/);
  const ini = m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 8 * 60;
  // Último turno que comienza dentro del último día (puede terminar al día siguiente).
  let ultimo = ini % (H * 60);
  while (ultimo + H * 60 < 24 * 60) ultimo += H * 60;
  return instanteChile(dia, ultimo + H * 60);
}

async function sbGet(ruta) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error("supabase " + r.status + " " + ruta.split("?")[0]);
  return r.json();
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

async function borrarClaves(cfg, claves) {
  let n = 0;
  for (let i = 0; i < claves.length; i += 10) {
    await Promise.all(claves.slice(i, i + 10).map(async clave => {
      try {
        const r = await fetch(prefirmar(cfg, { metodo: "DELETE", clave, fecha: new Date(), expira: 300 }), { method: "DELETE" });
        if (r.ok || r.status === 404) n++;
      } catch { /* se reintenta en la próxima ejecución */ }
    }));
  }
  return n;
}

// ---------- Biometría: tablas cerradas, solo con la service_role key ----------
async function sbServicio(clave, ruta, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...opts, headers: { apikey: clave, authorization: `Bearer ${clave}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error("supabase " + r.status + " " + ruta.split("?")[0]);
  return r.status === 204 ? null : r.json();
}
const lista = ruts => ruts.map(r => encodeURIComponent('"' + r + '"')).join(",");

async function borrarBiometria(eventos, ahora) {
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clave) { console.warn("borrar-fotos: sin SUPABASE_SERVICE_ROLE_KEY, no se borra la biometría"); return; }
  const limite = new Date(ahora - RETENCION_MS).toISOString();

  // RUT que todavía tienen un evento vigente: sus datos biométricos se conservan.
  const vigentes = new Set();
  const evVigentes = eventos.filter(ev => { const f = finEvento(ev); return f == null || ahora < f + RETENCION_MS; })
    .map(ev => ev.id).filter(id => RE_UUID.test(id));
  for (let i = 0; i < evVigentes.length; i += 50) {
    const filas = await sbServicio(clave, `asistencias?select=rut&evento_id=in.(${evVigentes.slice(i, i + 50).join(",")})&limit=100000`);
    for (const f of filas) { const r = normRut(f.rut); if (r) vigentes.add(r); }
  }
  // Partidos cerrados hace menos de 12 h (sus asistencias ya pasaron al historial).
  const hist = (await sbServicio(clave, `partidos_historial?select=id&cerrado_at=gte.${encodeURIComponent(limite)}&limit=2000`))
    .map(h => h.id).filter(id => RE_UUID.test(id));
  for (let i = 0; i < hist.length; i += 50) {
    const filas = await sbServicio(clave, `partidos_historial_asist?select=rut&historial_id=in.(${hist.slice(i, i + 50).join(",")})&limit=100000`);
    for (const f of filas) { const r = normRut(f.rut); if (r) vigentes.add(r); }
  }

  // Plantillas e intentos de más de 12 h de RUT sin evento vigente.
  const plantillas = [...new Set((await sbServicio(clave, `guardias_biometria?select=rut&fecha_enrolamiento=lt.${encodeURIComponent(limite)}&limit=100000`))
    .map(f => f.rut))].filter(r => !vigentes.has(normRut(r)));
  const intentos = [...new Set((await sbServicio(clave, `biometria_intentos?select=rut&fecha=lt.${encodeURIComponent(limite)}&limit=100000`))
    .map(f => f.rut))].filter(r => !vigentes.has(normRut(r)));
  const borrarDe = async (ruta, ruts) => {
    for (let i = 0; i < ruts.length; i += 100)
      await sbServicio(clave, ruta + `rut=in.(${lista(ruts.slice(i, i + 100))})`, { method: "DELETE", headers: { prefer: "return=minimal" } });
  };
  await borrarDe(`biometria_intentos?fecha=lt.${encodeURIComponent(limite)}&`, intentos);
  await borrarDe(`guardias_biometria?fecha_enrolamiento=lt.${encodeURIComponent(limite)}&`, plantillas);
  console.log(`borrar-fotos: biometría borrada de ${plantillas.length} plantilla(s) y de los intentos de ${intentos.length} RUT`);
}

export default async () => {
  const ahora = Date.now();
  const eventos = await sbGet("eventos?select=id,tipo,usa_turnos,turno_horas,turno_inicio,fecha_evento,fecha_hasta");
  try { await borrarBiometria(eventos, ahora); } catch (e) { console.error("borrar-fotos biometría:", e && e.message); }

  const cfg = configR2();
  if (!cfg) { console.warn("borrar-fotos: R2 no configurado"); return; }
  let borradas = 0;

  // 1) Eventos terminados hace más de 12 h: se borra toda su carpeta en R2.
  for (const ev of eventos) {
    const fin = finEvento(ev);
    if (fin == null || ahora < fin + RETENCION_MS || !RE_UUID.test(ev.id)) continue;
    try {
      const claves = (await listarPrefijo(cfg, ev.id + "/")).filter(k => RE_RUTA.test(k));
      if (claves.length) borradas += await borrarClaves(cfg, claves);
    } catch (e) { console.error("borrar-fotos evento", ev.id, e && e.message); }
  }

  // 2) Partidos cerrados hace más de 12 h: se borran las fotos que quedaron en su historial
  //    (el evento del partido se reutiliza, por eso no se borra su carpeta completa). Solo se
  //    piden a R2 las fotos que todavía existen (se lista la carpeta del evento una vez).
  try {
    const limite = new Date(ahora - RETENCION_MS).toISOString();
    const hist = await sbGet(`partidos_historial?select=id&cerrado_at=lt.${encodeURIComponent(limite)}&limit=2000`);
    const vencidas = new Set();
    for (let i = 0; i < hist.length; i += 50) {
      const ids = hist.slice(i, i + 50).map(h => h.id).filter(id => RE_UUID.test(id));
      if (!ids.length) continue;
      const filas = await sbGet(`partidos_historial_asist?select=foto_url&foto_url=not.is.null&historial_id=in.(${ids.join(",")})`);
      for (const f of filas) {
        const p = String(f.foto_url || "").replace(/^r2:/, "");
        if (RE_RUTA.test(p)) { vencidas.add(p); vencidas.add(p.replace(/\.webp$/i, "_t.webp")); }
      }
    }
    const carpetas = new Set([...vencidas].map(k => k.split("/")[0]));
    for (const c of carpetas) {
      const claves = (await listarPrefijo(cfg, c + "/")).filter(k => vencidas.has(k));
      if (claves.length) borradas += await borrarClaves(cfg, claves);
    }
  } catch (e) { console.error("borrar-fotos historial:", e && e.message); }

  console.log(`borrar-fotos: ${borradas} archivo(s) borrado(s)`);
};


