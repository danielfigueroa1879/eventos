// Netlify Function: AVISO POR CORREO cuando comienzan los ingresos de un evento.
//
// La llama la base de datos (Supabase) con un disparador en la tabla "asistencias" (ver
// supabase-aviso-ingreso.sql): no la llama el navegador, así nadie puede mandar correos falsos.
// Solo se envía UN correo por evento y por turno: el del PRIMER ingreso de ese turno (o del día, si
// el evento no usa turnos). Los demás ingresos no envían nada. Si algo falla, el ingreso del guardia
// NO se ve afectado (el disparador es asíncrono y esta función no escribe nada en la base).
//
// Variables de entorno de Netlify (Site configuration → Environment variables). Nunca en el código:
//   AVISO_TOKEN         clave compartida con el disparador de Supabase (texto largo al azar)
//   AVISO_DESTINOS      correos que reciben el aviso, separados por coma
//   GMAIL_USER          cuenta de Gmail que envía (ej. la del O.S.10)
//   GMAIL_APP_PASSWORD  "contraseña de aplicación" de esa cuenta (no la contraseña normal)
//
// El correo no incluye datos personales de los guardias (ni RUT ni nombre): solo evento, turno y hora.

import crypto from "node:crypto";
import nodemailer from "nodemailer";

// Datos PÚBLICOS de Supabase (los mismos de index.html): solo se LEEN el evento y sus ingresos.
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://ixdpjkfkbndcijowynxn.supabase.co").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZHBqa2ZrYm5kY2lqb3d5bnhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTgxNTIsImV4cCI6MjEwNzMzNDE1Mn0.qeeELjWAkMcDviavQSvsC5IQvLB-iG-KkdpdH3OCHdI";
const ZONA = "America/Santiago";
const TURNO_HORAS_DEFAULT = 12, TURNO_INICIO_DEFAULT = "08:00";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function tokenValido(dado) {
  const esperado = process.env.AVISO_TOKEN || "";
  if (!esperado || typeof dado !== "string") return false;
  const a = crypto.createHash("sha256").update(dado).digest(), b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

async function sb(ruta) {
  const r = await fetch(SUPABASE_URL + ruta, { headers: { apikey: SUPABASE_ANON_KEY, authorization: "Bearer " + SUPABASE_ANON_KEY } });
  if (!r.ok) throw new Error("supabase " + r.status);
  return r.json();
}

// Hora "de pared" en Chile de un instante (para calcular turnos igual que el panel).
function enChile(fecha) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(fecha).filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
  return p; // { year, month, day, hour, minute, second }
}
// Convierte una hora de pared de Chile a instante real (UTC).
function desdeChile(y, mo, d, h, mi) {
  const supuesto = Date.UTC(y, mo - 1, d, h, mi);
  const w = enChile(new Date(supuesto));
  const desfase = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - supuesto;
  return new Date(supuesto - desfase);
}
const pad = n => String(n).padStart(2, "0");

const usaTurnos = ev => !!ev && ev.tipo !== "partido" && ev.usa_turnos !== false;

// Ventana del turno al que pertenece el ingreso (misma regla que calcularTurno() del panel, incluida
// la llegada temprana de hasta 2 h). Sin turnos: el día calendario en Chile.
function ventana(ev, t) {
  const w = enChile(t);
  if (!usaTurnos(ev)) {
    // Horario único (p. ej. 23:00 a 05:00 del día siguiente): la jornada empieza 2 h antes del inicio,
    // así los ingresos de después de medianoche cuentan para la MISMA jornada (un solo correo).
    const h = ev.tipo !== "partido" && ev.dotacion && ev.dotacion.horario;
    const hm = x => { const m = /^(\d{2}):(\d{2})$/.exec(String(x || "")); return m ? +m[1] * 60 + +m[2] : null; };
    const ini = h ? hm(h.inicio) : null, fin = h ? hm(h.fin) : null;
    if (ini != null && fin != null) {
      let desde = new Date(desdeChile(w.year, w.month, w.day, 0, 0).getTime() + (ini - 120) * 60000);
      if (desde > t) desde = new Date(desde.getTime() - 86400000);
      return { desde, etiqueta: "Horario", rango: h.inicio + "–" + h.fin };
    }
    return { desde: desdeChile(w.year, w.month, w.day, 0, 0), etiqueta: null, rango: null };
  }
  let H = parseFloat(ev.turno_horas); if (!(H > 0)) H = TURNO_HORAS_DEFAULT; H = Math.min(24, Math.max(1, H));
  const m = /^(\d{1,2}):(\d{2})$/.exec(ev.turno_inicio || TURNO_INICIO_DEFAULT);
  const sh = Math.min(23, Math.max(0, m ? +m[1] : 8)), sm = Math.min(59, Math.max(0, m ? +m[2] : 0));
  const graceMin = Math.min(120, Math.floor(H * 30));
  let delta = (w.hour * 60 + w.minute) - (sh * 60 + sm - graceMin), dayOff = 0;
  if (delta < 0) { delta += 1440; dayOff = -1; }
  const idx = Math.floor(delta / (H * 60));
  const perDay = Math.max(1, Math.ceil(24 / H));
  const base = desdeChile(w.year, w.month, w.day, sh, sm);
  const inicio = new Date(base.getTime() + dayOff * 86400000 + idx * H * 3600000);
  const fin = new Date(inicio.getTime() + H * 3600000);
  const hm = d => { const x = enChile(d); return pad(x.hour) + ":" + pad(x.minute); };
  const etiqueta = perDay === 2 ? (idx === 0 ? "Turno Día" : "Turno Noche") : "Turno " + (idx + 1);
  return { desde: new Date(inicio.getTime() - graceMin * 60000), etiqueta, rango: hm(inicio) + "–" + hm(fin) };
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  if (!tokenValido(req.headers.get("x-aviso-token"))) return json({ error: "No autorizado" }, 401);
  let b; try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const rec = (b && (b.record || b)) || {};
  const id = String(rec.id || ""), evId = String(rec.evento_id || "");
  if (!UUID.test(id) || !UUID.test(evId)) return json({ ok: true, enviado: false, motivo: "registro inválido" });
  const t = new Date(rec.hora_ingreso || Date.now());
  if (isNaN(t.getTime())) return json({ ok: true, enviado: false, motivo: "hora inválida" });

  try {
    const [ev] = await sb(`/rest/v1/eventos?id=eq.${evId}&select=id,nombre_evento,empresa,tipo,usa_turnos,turno_horas,turno_inicio,cantidad_esperada,dotacion&limit=1`);
    if (!ev) return json({ ok: true, enviado: false, motivo: "evento no encontrado" });
    const v = ventana(ev, t);
    // ¿Es el PRIMER ingreso de esta ventana? (orden por hora y, en empate, por id: así, aunque entren
    // dos guardias al mismo tiempo, exactamente uno de los dos dispara el aviso).
    const previos = await sb(`/rest/v1/asistencias?evento_id=eq.${evId}&hora_ingreso=gte.${encodeURIComponent(v.desde.toISOString())}&hora_ingreso=lte.${encodeURIComponent(t.toISOString())}&select=id,hora_ingreso&order=hora_ingreso.asc,id.asc&limit=1`);
    if (previos.length && previos[0].id !== id) return json({ ok: true, enviado: false, motivo: "no es el primero" });

    const destinos = String(process.env.AVISO_DESTINOS || "").split(",").map(s => s.trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
    if (!destinos.length || !user || !pass) return json({ ok: true, enviado: false, motivo: "correo no configurado" });

    const hc = enChile(t), hora = pad(hc.hour) + ":" + pad(hc.minute), fecha = pad(hc.day) + "/" + pad(hc.month) + "/" + hc.year;
    const sitio = (process.env.URL || "").replace(/\/+$/, "");
    const esHorario = v.etiqueta === "Horario";
    const turnoTxt = !v.etiqueta ? "" : esHorario ? v.rango : `${v.etiqueta} (${v.rango})`;
    const etTurno = esHorario ? "Horario" : "Turno";
    const asunto = `🟢 Comenzaron los ingresos — ${ev.nombre_evento}${v.etiqueta ? " · " + (esHorario ? "Horario " + v.rango : v.etiqueta) : ""}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#0f5323;color:#fff;padding:14px 18px;font-weight:bold;font-size:16px">O.S.10 Coquimbo · Control de eventos</div>
  <div style="padding:18px;color:#0f172a;font-size:14px;line-height:1.5">
    <div style="font-size:17px;font-weight:bold;margin-bottom:6px">🟢 Comenzaron los ingresos</div>
    <div><b>Evento:</b> ${esc(ev.nombre_evento)}</div>
    <div><b>Empresa:</b> ${esc(ev.empresa)}</div>
    ${turnoTxt ? `<div><b>${etTurno}:</b> ${esc(turnoTxt)}</div>` : ""}
    <div><b>Primer ingreso:</b> ${fecha}, ${hora}</div>
    ${ev.cantidad_esperada ? `<div><b>Guardias esperados:</b> ${esc(ev.cantidad_esperada)}</div>` : ""}
    ${sitio ? `<div style="margin-top:16px"><a href="${esc(sitio)}/" style="background:#0f5323;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block;font-weight:bold">Abrir el panel</a></div>` : ""}
  </div>
  <div style="padding:10px 18px;background:#f8fafc;color:#64748b;font-size:11px">Aviso automático: se envía solo con el primer ingreso de cada turno.</div>
</div>`;
    const texto = `Comenzaron los ingresos\nEvento: ${ev.nombre_evento}\nEmpresa: ${ev.empresa || ""}\n${turnoTxt ? etTurno + ": " + turnoTxt + "\n" : ""}Primer ingreso: ${fecha}, ${hora}\n${sitio ? sitio + "/" : ""}`;

    const tx = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await tx.sendMail({ from: `"O.S.10 Coquimbo · Eventos" <${user}>`, to: destinos.join(", "), subject: asunto, text: texto, html });
    return json({ ok: true, enviado: true });
  } catch (e) {
    console.error("aviso-ingreso:", e && e.message);
    return json({ ok: false, error: "No se pudo enviar el aviso" }, 500);
  }
};

// Exportado solo para las pruebas.
export const _interno = { ventana, enChile, desdeChile };
