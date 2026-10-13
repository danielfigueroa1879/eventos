// PILOTO BIOMÉTRICO — PASO 0 / 0b: DIAGNÓSTICO (0b: SFace fp32, 2 imágenes cronometradas).
// Solo comprueba que Netlify puede empaquetar y ejecutar YuNet + SFace int8 (WebAssembly) y mide
// tiempos y memoria con 3 imágenes PÚBLICAS de prueba incluidas en el paquete. NO usa base de datos,
// NO usa claves, NO recibe imágenes del usuario y NO guarda nada.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const T_MODULO = Date.now();          // primera carga del módulo (arranque en frío)
let invocaciones = 0;
let cache = null;                     // sesiones cargadas (se reutilizan mientras la instancia siga viva)

// Huellas SHA-256 de los modelos (OpenCV Zoo): si un archivo cambia, no se usa.
const MODELOS = {
  det: { archivo: "face_detection_yunet_2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4" },
  rec: { archivo: "face_recognition_sface_2021dec.onnx", sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79" },   // SFace fp32 (paso 0b)
};
const WASM = "ort-wasm-simd-threaded.wasm", WASM_MJS = "ort-wasm-simd-threaded.mjs";
// Paso 0b: se CRONOMETRAN solo 2 imágenes (como una verificación real con 2 frames). La imagen de
// otra persona (b1) se procesa DESPUÉS y aparte, solo para el score de "persona distinta".
const PRUEBAS = [["a1.jpg", "A"], ["a2.jpg", "A"]];
const IMPOSTOR = "b1.jpg";

const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo, null, 2), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
});
const mb = n => Math.round(n / 1048576 * 10) / 10;
const ms = t => Math.round(t);

// Busca un archivo incluido en el paquete probando las raíces posibles (local, Lambda, bundle).
function buscar(rel, raices) {
  for (const r of raices) { const p = path.join(r, rel); if (fs.existsSync(p)) return p; }
  return null;
}

async function cargarTodo(errores, avisos) {
  const t0 = performance.now();
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const raices = [...new Set([aqui, process.env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(aqui, ".."), path.resolve(aqui, "../.."), path.resolve(aqui, "../../..")].filter(Boolean))];
  const rutas = {
    det: buscar(`netlify/functions/biometria/modelos/${MODELOS.det.archivo}`, raices) || buscar(`modelos/${MODELOS.det.archivo}`, raices),
    rec: buscar(`netlify/functions/biometria/modelos/${MODELOS.rec.archivo}`, raices) || buscar(`modelos/${MODELOS.rec.archivo}`, raices),
    wasm: buscar(`node_modules/onnxruntime-web/dist/${WASM}`, raices),
    wasmMjs: buscar(`node_modules/onnxruntime-web/dist/${WASM_MJS}`, raices),
    prueba: buscar("netlify/functions/biometria/prueba/a1.jpg", raices) || buscar("prueba/a1.jpg", raices),
  };
  const faltan = Object.entries(rutas).filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) { errores.push("Archivos no empaquetados: " + faltan.join(", ")); return { rutas, raices }; }

  const tamanos = {};
  for (const [k, p] of Object.entries(rutas)) tamanos[k] = mb(fs.statSync(p).size) + " MB";

  // 1) Integridad de los modelos.
  const bytes = {};
  for (const k of ["det", "rec"]) {
    bytes[k] = fs.readFileSync(rutas[k]);
    const h = crypto.createHash("sha256").update(bytes[k]).digest("hex");
    if (h !== MODELOS[k].sha256) errores.push(`Huella distinta en ${MODELOS[k].archivo}`);
  }
  if (errores.length) return { rutas, tamanos };

  // 2) onnxruntime-web en WebAssembly, 1 hilo, con el .wasm y su cargador leídos desde el paquete.
  const t1 = performance.now();
  const v = await import("./vision.mjs");
  v.ort.env.logLevel = "error";
  v.ort.env.wasm.numThreads = 1;
  v.ort.env.wasm.wasmBinary = fs.readFileSync(rutas.wasm);
  v.ort.env.wasm.wasmPaths = { mjs: pathToFileURL(rutas.wasmMjs).href, wasm: pathToFileURL(rutas.wasm).href };
  const tImport = performance.now() - t1;

  const t2 = performance.now(); const det = await v.crearSesion(bytes.det); const tDet = performance.now() - t2;
  const t3 = performance.now(); const rec = await v.crearSesion(bytes.rec); const tRec = performance.now() - t3;
  return { v, det, rec, rutas, tamanos, tiempos: { importar_ms: ms(tImport), cargar_yunet_ms: ms(tDet), cargar_sface_ms: ms(tRec), total_carga_ms: ms(performance.now() - t0) } };
}

export default async (req) => {
  invocaciones++;
  const tInicio = performance.now();
  const frio = !cache;
  const errores = [], avisos = [];
  const url = new URL(req.url);
  let accion = url.searchParams.get("accion");
  if (!accion && req.method === "POST") { try { accion = (await req.json()).accion; } catch { /* sin cuerpo */ } }
  if (accion !== "diagnostico") return json({ error: "Paso 0 del piloto: solo existe la acción 'diagnostico'." }, 400);

  try {
    if (!cache) cache = await cargarTodo(errores, avisos);
    const c = cache;
    if (errores.length || !c.v) { const r = { ok: false, errores, rutas: c && c.rutas, raices: c && c.raices }; cache = null; return json(r, 500); }

    const dirPrueba = path.dirname(c.rutas.prueba);
    const resultados = [], emb = {};
    for (const [archivo, persona] of PRUEBAS) {
      const ta = performance.now(); const im = c.v.decodificarJPEG(fs.readFileSync(path.join(dirPrueba, archivo))); const tDec = performance.now() - ta;
      const tb = performance.now(); const caras = await c.v.detectar(c.det, im); const tDetec = performance.now() - tb;
      if (!caras.length) { errores.push(`Sin rostro detectado en ${archivo}`); continue; }
      const tc = performance.now(); emb[archivo] = await c.v.embedding(c.rec, im, caras[0]); const tEmb = performance.now() - tc;
      resultados.push({ archivo, persona, tamano: `${im.w}x${im.h}`, caras: caras.length, score_deteccion: +caras[0].score.toFixed(3), decodificar_ms: ms(tDec), detectar_ms: ms(tDetec), embedding_ms: ms(tEmb) });
    }
    const tProc = performance.now() - tInicio;   // hasta aquí: carga (si fue en frío) + 2 imágenes
    const ti = performance.now();
    try { const im = c.v.decodificarJPEG(fs.readFileSync(path.join(dirPrueba, IMPOSTOR))); const cr = await c.v.detectar(c.det, im); if (cr.length) emb[IMPOSTOR] = await c.v.embedding(c.rec, im, cr[0]); else errores.push("Sin rostro en " + IMPOSTOR); } catch (e) { errores.push("impostor: " + e.message); }
    const tImpostor = performance.now() - ti;
    const cmp = (x, y) => (emb[x] && emb[y]) ? +c.v.coseno(emb[x], emb[y]).toFixed(3) : null;
    const comparaciones = {
      "a1 vs a2 (misma persona, esperado >= 0.363)": cmp("a1.jpg", "a2.jpg"),
      "a1 vs b1 (personas distintas, esperado < 0.363)": cmp("a1.jpg", "b1.jpg"),
      "a2 vs b1 (personas distintas, esperado < 0.363)": cmp("a2.jpg", "b1.jpg"),
    };
    const s = Object.values(comparaciones);
    if (!(s[0] >= 0.363 && s[1] < 0.363 && s[2] < 0.363)) avisos.push("Las comparaciones no dieron el resultado esperado.");
    const mem = process.memoryUsage();
    return json({
      ok: !errores.length,
      arranque_en_frio: frio,
      invocacion_de_esta_instancia: invocaciones,
      ms_desde_carga_del_modulo: Date.now() - T_MODULO,
      tiempos: { ...(frio ? c.tiempos : { carga: "reutilizada (instancia caliente)" }), procesar_2_imagenes_ms: ms(resultados.reduce((a, r) => a + r.decodificar_ms + r.detectar_ms + r.embedding_ms, 0)), total_interno_2_imagenes_ms: ms(tProc), extra_imagen_impostor_ms: ms(tImpostor), total_invocacion_ms: ms(performance.now() - tInicio) },
      resultados, comparaciones,
      memoria: { rss_mb: mb(mem.rss), heap_usado_mb: mb(mem.heapUsed), externa_mb: mb(mem.external), arraybuffers_mb: mb(mem.arrayBuffers), limite_lambda_mb: +process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || null },
      entorno: { node: process.version, plataforma: `${process.platform}/${process.arch}`, cpus: (await import("node:os")).cpus().length, region: process.env.AWS_REGION || null },
      archivos: c.tamanos,
      errores, avisos,
    });
  } catch (e) {
    cache = null;
    return json({ ok: false, errores: [...errores, String(e && e.stack || e).slice(0, 1500)] }, 500);
  }
};
