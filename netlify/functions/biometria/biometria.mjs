// PILOTO BIOMÉTRICO — ETAPA 1 (aislado de producción).
// Verificación facial 1:1 contra la plantilla del RUT indicado. NUNCA identifica 1:N, NUNCA bloquea
// ni modifica asistencias, NO usa R2 ni las fotos de ingreso, y NO guarda imágenes.
//
// Acciones (POST JSON):
//   { accion: "precalentar", rut }                                   -> carga los modelos (sin datos)
//   { accion: "desafio", pin, rut, tipo: "enrolamiento"|"verificacion" } -> pasos + token firmado (90 s)
//   { accion: "enrolar", pin, rut, token, consentimiento: true, imagenes: [jpeg base64 x3] }
//   { accion: "verificar", pin, rut, token, imagenes: [jpeg base64 x2] }
//   { accion: "estado", pin, rut }                                   -> enrolado / últimos intentos (sin plantilla)
//   { accion: "borrar", pin, rut }                                   -> elimina la plantilla de ese RUT
// INGRESO con interruptor encendido (SIN PIN). La MISMA captura de frente es la foto de ingreso y la
// imagen biométrica. Si el RUT YA tiene plantilla activa, se verifica automáticamente. Si NO tiene plantilla,
// el primer ingreso válido crea y activa la plantilla automáticamente después de superar la prueba de vida.
// Esto permite incorporar guardias nuevos/de apoyo sin depender de una aprobación manual del administrador.
//   { accion: "desafio_auto", rut }                                  -> { modo, pasos: [frente, 1 giro], token }
//   { accion: "procesar_auto", rut, asistencia_id, token, consentimiento: true, imagenes: [jpeg base64 x2] }
//      (asistencia de ese RUT creada hace < 15 min; nunca se escribe en "asistencias")
// PANEL ADMIN (con PIN): { accion: "resultados", pin, asistencia_ids: [...] } -> último resultado por asistencia
//                        { accion: "purgar", pin } -> RETENCIÓN 60 días: borra intentos con más de 60 días y
//                        plantillas de RUT sin intentos en 60 días (y enroladas hace más de 60 días)
// El resultado es ORIENTATIVO: nunca bloquea, modifica ni borra la asistencia (no se escribe en "asistencias").
//
// Variables de entorno (SOLO en Netlify; sin ellas la función responde 503 y no hace nada):
//   SUPABASE_SERVICE_ROLE_KEY, BIOMETRIA_KEY (32 bytes en base64 o hex), BIOMETRIA_PILOTO_RUTS (RUTs separados por coma)
//   SUPABASE_URL (opcional; por defecto el proyecto actual)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as L from "./logica.mjs";

const SUPABASE_URL_DEF = "https://ixdpjkfkbndcijowynxn.supabase.co";
const MODELOS = {
  det: { archivo: "face_detection_yunet_2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4" },
  rec: { archivo: "face_recognition_sface_2021dec.onnx", sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79" },
};
const WASM = "ort-wasm-simd-threaded.wasm", WASM_MJS = "ort-wasm-simd-threaded.mjs";
const MAX_IMG_BYTES = 400 * 1024, MAX_IMG_LADO = 1280;
const LIMITE_INTENTOS = 30, VENTANA_LIMITE_MS = 10 * 60 * 1000;   // piloto: holgado para calibrar
const INGRESO_PLAZO_MS = 15 * 60 * 1000, INGRESO_MAX_INTENTOS = 2;   // por asistencia
const RETENCION_DIAS = 60;   // limpieza biométrica cada 2 meses

const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
});
const ms = t => Math.round(t);
class ErrorCliente extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function config() {
  const k = L.claves(process.env.BIOMETRIA_KEY);
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const crudo = String(process.env.BIOMETRIA_PILOTO_RUTS || "");
  const todos = crudo.split(",").some(x => x.trim() === "*");   // "*" = cualquier RUT
  const ruts = crudo.split(",").map(L.normRut).filter(Boolean);
  if (!k || !srk || (!todos && !ruts.length)) return null;
  return { k, srk, todos, ruts: new Set(ruts), url: (process.env.SUPABASE_URL || SUPABASE_URL_DEF).replace(/\/+$/, "") };
}

// ---------- Modelos (se cargan una vez por instancia) ----------
let modelos = null, cargando = null;
function buscar(rel, raices) { for (const r of raices) { const p = path.join(r, rel); if (fs.existsSync(p)) return p; } return null; }
async function cargarModelos() {
  if (modelos) return { ...modelos, frio: false };
  if (!cargando) cargando = (async () => {
    const t0 = performance.now();
    const aqui = path.dirname(fileURLToPath(import.meta.url));
    const raices = [...new Set([aqui, process.env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(aqui, ".."), path.resolve(aqui, "../.."), path.resolve(aqui, "../../..")].filter(Boolean))];
    const ruta = k => buscar(`netlify/functions/biometria/modelos/${MODELOS[k].archivo}`, raices) || buscar(`modelos/${MODELOS[k].archivo}`, raices);
    const r = { det: ruta("det"), rec: ruta("rec"), wasm: buscar(`node_modules/onnxruntime-web/dist/${WASM}`, raices), wasmMjs: buscar(`node_modules/onnxruntime-web/dist/${WASM_MJS}`, raices) };
    const faltan = Object.entries(r).filter(([, v]) => !v).map(([n]) => n);
    if (faltan.length) throw new Error("Archivos no empaquetados: " + faltan.join(", "));
    const bytes = {};
    for (const n of ["det", "rec"]) {
      bytes[n] = fs.readFileSync(r[n]);
      if (crypto.createHash("sha256").update(bytes[n]).digest("hex") !== MODELOS[n].sha256) throw new Error("Huella distinta en " + MODELOS[n].archivo);
    }
    const v = await import("./vision.mjs");
    v.ort.env.logLevel = "error"; v.ort.env.wasm.numThreads = 1;
    v.ort.env.wasm.wasmBinary = fs.readFileSync(r.wasm);
    v.ort.env.wasm.wasmPaths = { mjs: pathToFileURL(r.wasmMjs).href, wasm: pathToFileURL(r.wasm).href };
    const det = await v.crearSesion(bytes.det), rec = await v.crearSesion(bytes.rec);
    modelos = { v, det, rec, carga_ms: ms(performance.now() - t0) };
    return modelos;
  })().finally(() => { cargando = null; });
  const m = await cargando;
  return { ...m, frio: true };
}

// ---------- Supabase (service role, solo las 2 tablas biométricas y verificar_clave) ----------
async function sbFetch(cfg, ruta, opts = {}) {
  const r = await fetch(`${cfg.url}${ruta}`, {
    ...opts,
    headers: { apikey: cfg.srk, authorization: `Bearer ${cfg.srk}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(`supabase ${r.status}`); e.status = r.status; e.cuerpo = txt.slice(0, 300); throw e; }
  return txt ? JSON.parse(txt) : null;
}
const PIN_OK_MS = 10 * 60 * 1000, pinesOk = new Map();
async function exigirPin(cfg, pin) {
  if (typeof pin !== "string" || !pin || pin.length > 64) throw new ErrorCliente("PIN requerido", 401);
  const h = crypto.createHash("sha256").update("os10-bio|" + pin).digest("hex");
  if ((pinesOk.get(h) || 0) > Date.now()) return;
  const ok = await sbFetch(cfg, "/rest/v1/rpc/verificar_clave", { method: "POST", body: JSON.stringify({ p_nombre: "admin", p_clave: pin }) });
  if (ok !== true) throw new ErrorCliente("PIN incorrecto", 401);
  pinesOk.set(h, Date.now() + PIN_OK_MS);
}
const enc = encodeURIComponent;
const leerPlantilla = async (cfg, rut) => (await sbFetch(cfg, `/rest/v1/guardias_biometria?select=rut,plantilla,modelo,version,muestras,fecha_enrolamiento,activo&rut=eq.${enc(rut)}&limit=1`))[0] || null;
async function registrarIntento(cfg, fila) {
  try { await sbFetch(cfg, "/rest/v1/biometria_intentos", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(fila) }); return true; }
  catch (e) { if (e.status === 409) throw new ErrorCliente("Este desafío ya fue usado. Pide uno nuevo.", 409); throw e; }
}
async function nonceUsado(cfg, nonce) { return (await sbFetch(cfg, `/rest/v1/biometria_intentos?select=id&nonce=eq.${enc(nonce)}&limit=1`)).length > 0; }
async function exigirLimite(cfg, rut) {
  const desde = new Date(Date.now() - VENTANA_LIMITE_MS).toISOString();
  const n = (await sbFetch(cfg, `/rest/v1/biometria_intentos?select=id&rut=eq.${enc(rut)}&fecha=gte.${enc(desde)}&limit=${LIMITE_INTENTOS + 1}`)).length;
  if (n >= LIMITE_INTENTOS) throw new ErrorCliente("Demasiados intentos. Espera unos minutos.", 429);
}

// La asistencia debe existir, ser de ESTE RUT y haberse creado hace menos de 15 min (hora del servidor:
// columna "creada"; si la base no la tiene, se usa hora_ingreso). Solo se LEE; nunca se modifica.
async function exigirAsistenciaReciente(cfg, rut, asisId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(asisId || ""))) throw new ErrorCliente("asistencia inválida");
  let filas;
  try { filas = await sbFetch(cfg, `/rest/v1/asistencias?select=id,rut,creada,hora_ingreso&id=eq.${enc(asisId)}&limit=1`); }
  catch (e) { if (e.status !== 400) throw e; filas = await sbFetch(cfg, `/rest/v1/asistencias?select=id,rut,hora_ingreso&id=eq.${enc(asisId)}&limit=1`); }
  const a = filas[0];
  if (!a || L.normRut(a.rut) !== rut) throw new ErrorCliente("asistencia no encontrada", 404);
  const t = Date.parse(a.creada || a.hora_ingreso);
  if (!(Date.now() - t < INGRESO_PLAZO_MS)) throw new ErrorCliente("plazo vencido para esta asistencia", 403);
  const n = (await sbFetch(cfg, `/rest/v1/biometria_intentos?select=id&asistencia_id=eq.${enc(asisId)}&limit=${INGRESO_MAX_INTENTOS + 1}`)).length;
  if (n >= INGRESO_MAX_INTENTOS) throw new ErrorCliente("ya se verificó esta asistencia", 429);
}

// Pista para el guardia cuando no supera la prueba de vida (sin revelar umbrales ni puntajes).
function pistaVida(motivos) {
  const m = (motivos || []).join(" | ");
  if (/más de un rostro/.test(m)) return "Debe aparecer solo una persona frente a la cámara.";
  if (/no se detectó rostro|muy lejos/.test(m)) return "Acércate a la cámara y deja tu rostro completo dentro del óvalo, con buena luz.";
  if (/lado contrario|no se detectó el giro/.test(m)) return "Gira la cabeza hacia el lado que indica la flecha y mantenla hasta ver 📸.";
  if (/no mira al frente/.test(m)) return "En la primera foto mira directo a la cámara.";
  return "Repite la verificación: mira al frente y luego gira la cabeza hacia la flecha.";
}

// ---------- Imágenes ----------
function decodificar(v, b64) {
  if (typeof b64 !== "string") throw new ErrorCliente("imagen inválida");
  const buf = Buffer.from(b64.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (buf.length < 1000 || buf.length > MAX_IMG_BYTES) throw new ErrorCliente("imagen de tamaño inválido");
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new ErrorCliente("solo se aceptan imágenes JPEG de la cámara");
  const im = v.decodificarJPEG(buf);
  if (im.w > MAX_IMG_LADO || im.h > MAX_IMG_LADO) throw new ErrorCliente("imagen demasiado grande");
  return im;
}
async function analizar(m, pasos, imagenes) {
  if (!Array.isArray(imagenes) || imagenes.length !== pasos.length) throw new ErrorCliente(`se esperaban ${pasos.length} imágenes`);
  const frames = [];
  for (let i = 0; i < pasos.length; i++) {
    const im = decodificar(m.v, imagenes[i]);
    const caras = await m.v.detectar(m.det, im);
    const f = { paso: pasos[i], caras: caras.length, ancho: im.w };
    if (caras.length) { f.cara = caras[0]; f.pose = m.v.pose(caras[0]); f.emb = await m.v.embedding(m.rec, im, caras[0]); }
    frames.push(f);
  }
  return frames;
}

// ---------- Handler ----------
export default async (req) => {
  const t0 = performance.now();
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  const cfg = config();
  if (!cfg) return json({ error: "Piloto biométrico no configurado." }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  try {
    // ----- Panel admin -> último resultado por asistencia (solo PIN; sin plantillas ni imágenes) -----
    if (b.accion === "resultados") {
      await exigirPin(cfg, b.pin);
      const ids = (Array.isArray(b.asistencia_ids) ? b.asistencia_ids : []).filter(x => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 300);
      if (!ids.length) return json({ ok: true, resultados: {} });
      const filas = await sbFetch(cfg, `/rest/v1/biometria_intentos?select=asistencia_id,rut,tipo,estado,score,liveness_ok,fecha&asistencia_id=in.(${ids.map(enc).join(",")})&order=fecha.desc`);
      const resultados = {};
      filas.forEach(f => { if (!resultados[f.asistencia_id]) resultados[f.asistencia_id] = { tipo: f.tipo, estado: f.estado, score: f.score, liveness_ok: f.liveness_ok, fecha: f.fecha, rut: f.rut }; });
      return json({ ok: true, resultados });
    }

    // ----- Vista empresa -> SOLO el estado (sin score, RUT ni detalle) de ingresos de SU evento -----
    // La empresa accede por el slug del evento (igual que a la lista de asistencias). Solo se responden
    // los ids que pertenecen a ese evento, y nada si el evento tiene la biometría desactivada.
    if (b.accion === "resultados_empresa") {
      const slug = String(b.slug || "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw new ErrorCliente("Evento inválido");
      const ids = (Array.isArray(b.asistencia_ids) ? b.asistencia_ids : []).filter(x => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 300);
      const ev = (await sbFetch(cfg, `/rest/v1/eventos?select=id,biometria&slug=eq.${enc(slug)}&limit=1`))[0];
      if (!ev || ev.biometria === false || !ids.length) return json({ ok: true, resultados: {} });
      const propias = (await sbFetch(cfg, `/rest/v1/asistencias?select=id&evento_id=eq.${enc(ev.id)}&id=in.(${ids.map(enc).join(",")})`)).map(f => f.id);
      if (!propias.length) return json({ ok: true, resultados: {} });
      const filas = await sbFetch(cfg, `/rest/v1/biometria_intentos?select=asistencia_id,estado,fecha&asistencia_id=in.(${propias.map(enc).join(",")})&order=fecha.desc`);
      const resultados = {};
      filas.forEach(f => { if (!resultados[f.asistencia_id]) resultados[f.asistencia_id] = { estado: f.estado }; });
      return json({ ok: true, resultados });
    }

    // ----- Panel admin -> retención de 60 días (solo PIN) -----
    if (b.accion === "purgar") {
      await exigirPin(cfg, b.pin);
      const corte = new Date(Date.now() - RETENCION_DIAS * 86400000).toISOString();
      // RUT con actividad reciente: sus plantillas se conservan.
      const recientes = new Set((await sbFetch(cfg, `/rest/v1/biometria_intentos?select=rut&fecha=gte.${enc(corte)}&limit=10000`)).map(f => f.rut));
      const viejas = (await sbFetch(cfg, `/rest/v1/guardias_biometria?select=rut&fecha_enrolamiento=lt.${enc(corte)}&limit=10000`)).map(f => f.rut).filter(r => !recientes.has(r));
      let plantillas = 0;
      for (let i = 0; i < viejas.length; i += 100) {
        const lote = viejas.slice(i, i + 100);
        await sbFetch(cfg, `/rest/v1/guardias_biometria?rut=in.(${lote.map(r => enc('"' + r + '"')).join(",")})`, { method: "DELETE", headers: { prefer: "return=minimal" } });
        plantillas += lote.length;
      }
      const borrados = await sbFetch(cfg, `/rest/v1/biometria_intentos?fecha=lt.${enc(corte)}&select=id`, { method: "DELETE", headers: { prefer: "return=representation" } });
      return json({ ok: true, plantillas, intentos: (borrados || []).length });
    }

    const rut = L.normRut(b.rut);
    if (!rut) throw new ErrorCliente("RUT inválido");
    if (!cfg.todos && !cfg.ruts.has(rut)) throw new ErrorCliente("Este RUT no participa en el piloto.", 403);

    if (b.accion === "precalentar") {
      const m = await cargarModelos();
      return json({ ok: true, frio: m.frio, carga_ms: m.frio ? m.carga_ms : 0, total_ms: ms(performance.now() - t0) });
    }

    // ----- Guía de giro EN VIVO (sin guardar imagen ni plantilla) -----
    // Devuelve solo la pose mínima necesaria para pintar la guía de la cámara.
    // No intenta medir la dirección de las pupilas: con YuNet solo validamos giro de cabeza,
    // cantidad de rostros y tamaño/encuadre del rostro.
    if (b.accion === "pose_live") {
      await exigirLimite(cfg, rut);
      const m = await cargarModelos();
      const im = decodificar(m.v, b.imagen);
      const caras = await m.v.detectar(m.det, im);
      if (caras.length !== 1) return json({ ok: true, caras: caras.length, listo: false });
      const cara = caras[0], pose = m.v.pose(cara), cara_frac = cara.box[2] / im.w;
      const dir = b.direccion === "izquierda" ? "izquierda" : b.direccion === "derecha" ? "derecha" : null;
      let listo = false, progreso = 0, contrario = false, movimiento = false;
      if (dir && cara_frac >= L.CARA_MIN_FRAC) {
        const signo = L.CONVENCION_GIRO[dir];
        const avance = pose.giro * signo;
        // Zona muerta pequeña para que el ruido natural en reposo no cambie el color.
        const zonaMuerta = L.GIRO_LADO_MIN * 0.12;
        movimiento = Math.abs(avance) >= zonaMuerta;
        contrario = movimiento && avance < 0;
        if (movimiento && !contrario) {
          progreso = Math.max(0, Math.min(1, (avance - zonaMuerta) / (L.GIRO_LADO_MIN - zonaMuerta)));
        }
        listo = avance >= L.GIRO_LADO_MIN;
      }
      return json({
        ok: true,
        caras: 1,
        giro: +pose.giro.toFixed(3),
        cara_frac: +cara_frac.toFixed(3),
        movimiento,
        contrario,
        progreso: +progreso.toFixed(3),
        listo
      });
    }

    // ----- Ingreso con interruptor encendido (sin PIN) -----
    if (b.accion === "desafio_auto") {
      const [, p] = await Promise.all([exigirLimite(cfg, rut), leerPlantilla(cfg, rut)]);   // en paralelo
      const d = L.crearDesafio(cfg.k, rut, "auto");
      return json({ ok: true, modo: p && p.activo ? "verificacion" : "enrolamiento", pasos: d.pasos, token: d.token, vence: d.vence });
    }
    if (b.accion === "procesar_auto") {
      let d;
      try { d = L.leerDesafio(cfg.k, b.token); } catch (e) { throw new ErrorCliente(e.message); }
      if (d.rut !== rut || d.tipo !== "auto") throw new ErrorCliente("El desafío no corresponde a este RUT.");
      if (b.consentimiento !== true) throw new ErrorCliente("Falta el consentimiento.");
      // previo = verificación ANTES de registrar el ingreso (RUT ya enrolado): si el rostro NO COINCIDE
      // la app no registra el ingreso. El intento queda sin asistencia y luego se vincula ("vincular").
      const previo = b.previo === true;
      // En paralelo: validaciones en Supabase + plantilla + modelos (antes iban una tras otra).
      const [, usado, p, m] = await Promise.all([
        previo ? null : exigirAsistenciaReciente(cfg, rut, b.asistencia_id),
        nonceUsado(cfg, d.nonce), leerPlantilla(cfg, rut), cargarModelos()]);
      if (usado) throw new ErrorCliente("Este desafío ya fue usado.", 409);
      const tA = performance.now();
      const frames = await analizar(m, d.pasos, b.imagenes);
      const vida = L.evaluarVida(frames);
      const frente = frames.find(f => f.paso === "frente" && f.emb);
      const base = { rut, liveness_ok: vida.ok, modelo: L.MODELO, metodo: L.METODO + "+auto", nonce: d.nonce, asistencia_id: previo ? null : b.asistencia_id };
      const tiempos = () => ({ frio: m.frio, analisis_ms: ms(performance.now() - tA), total_ms: ms(performance.now() - t0) });
      // Prueba de vida NO superada en la verificación previa: el guardia debe REPETIR (no se registra).
      // Se responde una pista amable (sin score). En el primer ingreso (sin plantilla) el previo solo
      // revisa la prueba de vida: si la supera no se guarda nada y el enrolamiento ocurre tras registrar.
      // (Si el rostro es claramente de OTRA persona, manda el bloqueo de más abajo, no "repetir".)
      const otraPersona = !!(p && p.activo && frente) && L.coseno(L.descifrarPlantilla(cfg.k, rut, p.plantilla), frente.emb) < L.UMBRAL_NO_COINCIDE;
      if (previo && (!vida.ok || !frente) && !otraPersona) {
        await registrarIntento(cfg, { ...base, tipo: p && p.activo ? "verificacion" : "enrolamiento", estado: p && p.activo ? L.ESTADOS.REVISAR : "RECHAZADO", detalle: { motivo: "prueba de vida no superada (previa)", motivos: vida.motivos, medidas: vida.medidas }, duracion_ms: ms(performance.now() - t0) });
        return json({ ok: true, resultado: "repetir", reintentar: true, pista: pistaVida(vida.motivos), tiempos: tiempos() });
      }
      if (previo && (!p || !p.activo)) return json({ ok: true, resultado: "vida_ok", bloqueado: false, tiempos: tiempos() });
      if (!p || !p.activo) {
        // Primer ingreso: enrolamiento automático e inmediato para permitir guardias nuevos/de apoyo.
        // La plantilla solo se crea si supera la prueba de vida y existe una asistencia reciente del mismo RUT.
        if (!vida.ok || !frente) {
          await registrarIntento(cfg, { ...base, tipo: "enrolamiento", estado: "RECHAZADO", detalle: { motivos: vida.motivos, medidas: vida.medidas }, duracion_ms: ms(performance.now() - t0) });
          return json({ ok: true, resultado: "sin_enrolar", tiempos: tiempos() });
        }
        const ahora = new Date().toISOString();
        const fila = {
          rut,
          plantilla: L.cifrarPlantilla(cfg.k, rut, frente.emb),
          modelo: L.MODELO,
          version: p ? p.version + 1 : 1,
          muestras: 1,
          fecha_enrolamiento: ahora,
          consentimiento_fecha: ahora,
          enrolado_por: "auto-ingreso-inicial",
          activo: true
        };
        await registrarIntento(cfg, { ...base, tipo: "enrolamiento", estado: "ENROLADO", detalle: { motivo: "primer enrolamiento automático", medidas: vida.medidas, version: fila.version }, duracion_ms: ms(performance.now() - t0) });
        await sbFetch(cfg, "/rest/v1/guardias_biometria?on_conflict=rut", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(fila) });
        return json({ ok: true, resultado: "enrolado", primer_enrolamiento: true, tiempos: tiempos() });
      }
      // Ingresos siguientes: VERIFICACIÓN 1:1 contra la plantilla del RUT.
      const score = frente ? +L.coseno(L.descifrarPlantilla(cfg.k, rut, p.plantilla), frente.emb).toFixed(4) : null;
      const r = L.decidir(score, vida);
      await registrarIntento(cfg, { ...base, tipo: "verificacion", estado: r.estado, score, detalle: { motivo: r.motivo, motivos: vida.motivos, medidas: vida.medidas, version_plantilla: p.version }, duracion_ms: ms(performance.now() - t0) });
      // Al guardia no se le muestra el score. Solo en la verificación previa se le dice si quedó BLOQUEADO
      // (similitud baja = otra persona): en ese caso la app no registra el ingreso.
      const bloqueado = r.estado === L.ESTADOS.NO || (score != null && score < L.UMBRAL_NO_COINCIDE);
      return json({ ok: true, resultado: "registrado", ...(previo ? { bloqueado } : {}), tiempos: tiempos() });
    }
    // Tras registrar el ingreso: asocia la verificación previa (mismo desafío) a la asistencia recién creada.
    if (b.accion === "vincular") {
      let d;
      try { d = L.leerDesafio(cfg.k, b.token, 0); } catch (e) { throw new ErrorCliente(e.message); }   // firma válida; plazo abajo
      if (d.rut !== rut || d.tipo !== "auto") throw new ErrorCliente("El desafío no corresponde a este RUT.");
      if (Date.now() > d.vence + INGRESO_PLAZO_MS) throw new ErrorCliente("plazo vencido", 403);
      await exigirAsistenciaReciente(cfg, rut, b.asistencia_id);
      const f = await sbFetch(cfg, `/rest/v1/biometria_intentos?nonce=eq.${enc(d.nonce)}&rut=eq.${enc(rut)}&asistencia_id=is.null`, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify({ asistencia_id: b.asistencia_id }) });
      return json({ ok: true, vinculado: (f || []).length });
    }

    await exigirPin(cfg, b.pin);

    if (b.accion === "desafio") {
      const tipo = b.tipo === "enrolamiento" ? "enrolamiento" : "verificacion";
      await exigirLimite(cfg, rut);
      const d = L.crearDesafio(cfg.k, rut, tipo);
      return json({ ok: true, tipo, pasos: d.pasos, token: d.token, vence: d.vence });
    }

    if (b.accion === "estado") {
      const p = await leerPlantilla(cfg, rut);
      const intentos = await sbFetch(cfg, `/rest/v1/biometria_intentos?select=tipo,estado,score,liveness_ok,detalle,duracion_ms,fecha&rut=eq.${enc(rut)}&order=fecha.desc&limit=20`);
      return json({ ok: true, rut, enrolado: !!(p && p.activo), plantilla: p ? { version: p.version, modelo: p.modelo, muestras: p.muestras, fecha: p.fecha_enrolamiento } : null, intentos });
    }

    if (b.accion === "borrar") {
      await sbFetch(cfg, `/rest/v1/guardias_biometria?rut=eq.${enc(rut)}`, { method: "DELETE", headers: { prefer: "return=minimal" } });
      return json({ ok: true, borrado: true });
    }

    if (b.accion === "enrolar" || b.accion === "verificar") {
      const tipo = b.accion === "enrolar" ? "enrolamiento" : "verificacion";
      let d;
      try { d = L.leerDesafio(cfg.k, b.token); } catch (e) { throw new ErrorCliente(e.message); }
      if (d.rut !== rut || d.tipo !== tipo) throw new ErrorCliente("El desafío no corresponde a esta acción o RUT.");
      if (await nonceUsado(cfg, d.nonce)) throw new ErrorCliente("Este desafío ya fue usado. Pide uno nuevo.", 409);
      if (tipo === "enrolamiento" && b.consentimiento !== true) throw new ErrorCliente("Falta el consentimiento explícito.");

      const m = await cargarModelos();
      const tA = performance.now();
      const frames = await analizar(m, d.pasos, b.imagenes);
      const vida = L.evaluarVida(frames);
      const analisis_ms = ms(performance.now() - tA);
      const base = { rut, tipo, liveness_ok: vida.ok, modelo: L.MODELO, metodo: L.METODO, nonce: d.nonce };

      if (tipo === "enrolamiento") {
        const frentes = frames.filter(f => f.paso === "frente" && f.emb);
        const motivos = [...vida.motivos];
        if (frentes.length === 2 && L.coseno(frentes[0].emb, frentes[1].emb) < L.FRENTES_ENROL_MIN) motivos.push("las dos capturas frontales no son consistentes");
        if (motivos.length || frentes.length < 2) {
          await registrarIntento(cfg, { ...base, estado: "RECHAZADO", detalle: { motivos, medidas: vida.medidas }, duracion_ms: ms(performance.now() - t0) });
          return json({ ok: false, estado: "RECHAZADO", motivos, medidas: vida.medidas, tiempos: { frio: m.frio, analisis_ms, total_ms: ms(performance.now() - t0) } });
        }
        const previa = await leerPlantilla(cfg, rut);
        const fila = {
          rut, plantilla: L.cifrarPlantilla(cfg.k, rut, L.promedio(frentes.map(f => f.emb))), modelo: L.MODELO,
          version: previa ? previa.version + 1 : 1, muestras: frentes.length, fecha_enrolamiento: new Date().toISOString(),
          consentimiento_fecha: new Date().toISOString(), enrolado_por: "admin-pin", activo: true,
        };
        await registrarIntento(cfg, { ...base, estado: "ENROLADO", detalle: { medidas: vida.medidas, version: fila.version }, duracion_ms: ms(performance.now() - t0) });
        await sbFetch(cfg, "/rest/v1/guardias_biometria?on_conflict=rut", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(fila) });
        return json({ ok: true, estado: "ENROLADO", version: fila.version, medidas: vida.medidas, tiempos: { frio: m.frio, analisis_ms, total_ms: ms(performance.now() - t0) } });
      }

      // Verificación 1:1
      const p = await leerPlantilla(cfg, rut);
      let score = null;
      const frente = frames.find(f => f.paso === "frente" && f.emb);
      if (p && p.activo && frente) score = +L.coseno(L.descifrarPlantilla(cfg.k, rut, p.plantilla), frente.emb).toFixed(4);
      const r = L.decidir(score, vida);
      await registrarIntento(cfg, { ...base, estado: r.estado, score, detalle: { motivo: r.motivo, motivos: vida.motivos, medidas: vida.medidas, version_plantilla: p ? p.version : null }, duracion_ms: ms(performance.now() - t0) });
      return json({ ok: true, estado: r.estado, score, motivo: r.motivo, liveness_ok: vida.ok, motivos: vida.motivos, medidas: vida.medidas, umbrales: { verificado: L.UMBRAL_VERIFICADO, no_coincide: L.UMBRAL_NO_COINCIDE }, tiempos: { frio: m.frio, analisis_ms, total_ms: ms(performance.now() - t0) } });
    }

    throw new ErrorCliente("acción desconocida");
  } catch (e) {
    if (e instanceof ErrorCliente) return json({ error: e.message }, e.status);
    console.error("biometria:", e && e.message);   // sin datos del cuerpo, claves ni imágenes
    return json({ error: "Error del servidor" }, 502);
  }
};
