// PILOTO BIOMÉTRICO — lógica pura (sin red ni modelos): RUT, cifrado de plantillas, desafíos
// firmados, prueba de vida básica y decisión del estado. Se prueba por separado.
import crypto from "node:crypto";

export const MODELO = "yunet-2023mar+sface-2021dec-fp32";
export const METODO = "desafio-2giros-v2";
// Umbrales iniciales (coseno SFace). OpenCV documenta 0.363 como "misma persona".
// Se recalibran con los datos del piloto.
export const UMBRAL_VERIFICADO = 0.45;
export const UMBRAL_NO_COINCIDE = 0.30;
// Prueba de vida (desafío de giro)
export const GIRO_FRENTE_MAX = 0.20;     // |giro| máximo para considerar "mirando al frente" (0.15 rechazaba celulares algo de lado)
export const GIRO_LADO_MIN = 0.19;       // |giro| que pide la guía EN VIVO para ponerse verde
// La foto final acepta un poco menos (margen): se toma justo después de la guía y la cabeza puede volver
// levemente. "No giró lo suficiente" era la 1.ª causa de vida fallida (104 de 167 en 7 días).
export const GIRO_LADO_MIN_FINAL = 0.15;
export const MISMA_SESION_MIN = 0.22;    // coseno mínimo entre los frames de un mismo intento (de frente vs. girado; 0.30 fallaba con barba)
export const FRENTES_ENROL_MIN = 0.60;   // coseno mínimo entre los 2 frames frontales del enrolamiento
export const IDENTICOS_MAX = 0.995;      // por encima: frames prácticamente idénticos (imagen fija)
export const CARA_MIN_FRAC = 0.15;       // ancho mínimo del rostro respecto del ancho de la imagen (al girar el rostro se ve más angosto)
export const DESAFIO_MS = 90 * 1000;     // vigencia del desafío
// Convención: imagen SIN espejo; si la persona gira hacia SU izquierda, la nariz se desplaza hacia
// la derecha de la imagen (giro > 0). Se confirma con las primeras pruebas reales del piloto.
export const CONVENCION_GIRO = { izquierda: 1, derecha: -1 };

export const ESTADOS = { OK: "VERIFICADO", REVISAR: "REVISIÓN MANUAL", NO: "NO COINCIDE" };

// "12.345.678-k" -> "12345678-K"; null si no es un RUT con dígito verificador válido.
export function normRut(r) {
  const s = String(r || "").replace(/[^0-9kK]/g, "").toUpperCase();
  if (s.length < 2) return null;
  const cuerpo = s.slice(0, -1), dv = s.slice(-1);
  if (!/^\d{6,9}$/.test(cuerpo)) return null;
  let suma = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += +cuerpo[i] * m; m = m === 7 ? 2 : m + 1; }
  const r11 = 11 - (suma % 11), dvOk = r11 === 11 ? "0" : r11 === 10 ? "K" : String(r11);
  return dv === dvOk ? `${+cuerpo}-${dv}` : null;
}

// Clave de 32 bytes desde BIOMETRIA_KEY (base64 o hex); se derivan subclaves separadas.
export function claves(secreto) {
  let k = null;
  if (/^[0-9a-f]{64}$/i.test(secreto || "")) k = Buffer.from(secreto, "hex");
  else { try { k = Buffer.from(String(secreto || ""), "base64"); } catch { k = null; } }
  if (!k || k.length !== 32) return null;
  const deriva = etiqueta => crypto.createHmac("sha256", k).update(etiqueta).digest();
  return { cifrado: deriva("os10-bio-plantilla-v1"), firma: deriva("os10-bio-desafio-v1") };
}

// Plantilla (Float32Array 128) <-> texto cifrado. AAD = RUT: una plantilla copiada a otro RUT no descifra.
export function cifrarPlantilla(k, rut, vec) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k.cifrado, iv);
  c.setAAD(Buffer.from(rut));
  const datos = Buffer.concat([c.update(Buffer.from(Float32Array.from(vec).buffer)), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), datos]).toString("base64");
}
export function descifrarPlantilla(k, rut, txt) {
  if (!String(txt).startsWith("v1:")) throw new Error("formato de plantilla desconocido");
  const b = Buffer.from(txt.slice(3), "base64"), d = crypto.createDecipheriv("aes-256-gcm", k.cifrado, b.subarray(0, 12));
  d.setAAD(Buffer.from(rut)); d.setAuthTag(b.subarray(12, 28));
  const raw = Buffer.concat([d.update(b.subarray(28)), d.final()]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Desafío firmado (sin estado): qué pasos pedir, para qué RUT y acción, con vencimiento y nonce.
const b64u = b => Buffer.from(b).toString("base64url");
export function crearDesafio(k, rut, tipo, ahora = Date.now(), extra = {}) {
  // 2 giros, uno hacia cada lado, en ORDEN ALEATORIO: un video tendría que acertar el orden.
  const giros = crypto.randomInt(2) ? ["giro_izquierda", "giro_derecha"] : ["giro_derecha", "giro_izquierda"];
  // "auto" (ingreso con interruptor encendido): frente + UN solo giro, más simple para los guardias.
  const pasos = tipo === "enrolamiento" ? ["frente", ...giros, "frente"] : tipo === "auto" ? ["frente", giros[0]] : ["frente", ...giros];
  const datos = { rut, tipo, pasos, nonce: crypto.randomBytes(16).toString("hex"), vence: ahora + DESAFIO_MS, ...extra };
  const cuerpo = b64u(JSON.stringify(datos));
  return { token: cuerpo + "." + b64u(crypto.createHmac("sha256", k.firma).update(cuerpo).digest()), pasos, vence: datos.vence };
}
export function leerDesafio(k, token, ahora = Date.now()) {
  const [cuerpo, firma] = String(token || "").split(".");
  if (!cuerpo || !firma) throw new Error("desafío inválido");
  const esperada = crypto.createHmac("sha256", k.firma).update(cuerpo).digest();
  const dada = Buffer.from(firma, "base64url");
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) throw new Error("desafío inválido");
  const d = JSON.parse(Buffer.from(cuerpo, "base64url").toString());
  if (ahora > d.vence) throw new Error("desafío vencido");
  return d;
}

export const coseno = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export function promedio(vs) {
  const m = new Float32Array(vs[0].length);
  vs.forEach(v => v.forEach((x, i) => { m[i] += x; }));
  let n = 0; for (const x of m) n += x * x; n = Math.sqrt(n);
  return m.map(x => x / n);
}

// frames: [{ paso, caras, cara, pose, emb, ancho }] en el orden del desafío.
// Devuelve { ok, motivos, medidas }. Es una prueba de vida BÁSICA: frena una foto fija, no un video.
export function evaluarVida(frames) {
  const motivos = [], medidas = [];
  for (const f of frames) {
    const m = { paso: f.paso, caras: f.caras };
    if (f.caras === 0) { motivos.push(`${f.paso}: no se detectó rostro`); medidas.push(m); continue; }
    if (f.caras > 1) motivos.push(`${f.paso}: hay más de un rostro`);
    m.giro = +f.pose.giro.toFixed(3); m.score_det = +f.cara.score.toFixed(3); m.cara_frac = +(f.cara.box[2] / f.ancho).toFixed(3);
    if (m.cara_frac < CARA_MIN_FRAC) motivos.push(`${f.paso}: rostro muy lejos o pequeño`);
    if (f.paso === "frente" && Math.abs(f.pose.giro) > GIRO_FRENTE_MAX) motivos.push("frente: no mira al frente");
    if (f.paso.startsWith("giro_")) {
      const dir = f.paso.slice(5), signo = CONVENCION_GIRO[dir];
      if (Math.abs(f.pose.giro) < GIRO_LADO_MIN_FINAL) motivos.push(`giro: no se detectó el giro hacia la ${dir}`);
      else if (Math.sign(f.pose.giro) !== signo) motivos.push(`giro: la cabeza giró hacia el lado contrario (se pidió ${dir})`);
    }
    medidas.push(m);
  }
  const conEmb = frames.filter(f => f.emb);
  if (conEmb.length === frames.length) {
    const base = conEmb[0].emb;
    conEmb.slice(1).forEach(f => {
      const c = coseno(base, f.emb);
      if (c < MISMA_SESION_MIN) motivos.push(`${f.paso}: no parece la misma persona del primer frame`);
      if (c > IDENTICOS_MAX) motivos.push(`${f.paso}: imagen prácticamente idéntica (posible foto fija)`);
    });
  }
  return { ok: motivos.length === 0, motivos, medidas };
}

// Estado final de una verificación. La biometría nunca bloquea: solo informa.
export function decidir(score, vida) {
  if (score == null) return { estado: ESTADOS.REVISAR, motivo: "sin plantilla o sin rostro comparable" };
  if (!vida.ok) return { estado: ESTADOS.REVISAR, motivo: "prueba de vida no superada" };
  if (score >= UMBRAL_VERIFICADO) return { estado: ESTADOS.OK, motivo: null };
  if (score >= UMBRAL_NO_COINCIDE) return { estado: ESTADOS.REVISAR, motivo: "similitud intermedia" };
  return { estado: ESTADOS.NO, motivo: "similitud baja" };
}
