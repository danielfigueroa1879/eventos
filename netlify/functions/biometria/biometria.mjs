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

const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
});
const ms = t => Math.round(t);
class ErrorCliente extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function config() {
  const k = L.claves(process.env.BIOMETRIA_KEY);
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ruts = String(process.env.BIOMETRIA_PILOTO_RUTS || "").split(",").map(L.normRut).filter(Boolean);
  if (!k || !srk || !ruts.length) return null;
  return { k, srk, ruts: new Set(ruts), url: (process.env.SUPABASE_URL || SUPABASE_URL_DEF).replace(/\/+$/, "") };
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
    const rut = L.normRut(b.rut);
    if (!rut) throw new ErrorCliente("RUT inválido");
    if (!cfg.ruts.has(rut)) throw new ErrorCliente("Este RUT no participa en el piloto.", 403);

    if (b.accion === "precalentar") {
      const m = await cargarModelos();
      return json({ ok: true, frio: m.frio, carga_ms: m.frio ? m.carga_ms : 0, total_ms: ms(performance.now() - t0) });
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
