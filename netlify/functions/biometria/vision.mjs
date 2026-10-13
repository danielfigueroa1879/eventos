// PILOTO BIOMÉTRICO — visión (paso 0: solo diagnóstico).
// Detección de rostro con YuNet (OpenCV Zoo, MIT) y embedding con SFace int8 (OpenCV Zoo, Apache 2.0),
// ejecutados con onnxruntime-web (WebAssembly, sin binarios nativos). Replica el pre/post-proceso de
// cv::FaceDetectorYN y cv::FaceRecognizerSF de OpenCV.
import * as ort from "onnxruntime-web";
import jpeg from "jpeg-js";

const SZ = 640;   // entrada fija de YuNet 2023mar
export { ort };

export async function crearSesion(bytes) {
  return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
}

export function decodificarJPEG(buf) {
  const im = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 12, maxMemoryUsageInMB: 256 });
  return { w: im.width, h: im.height, d: im.data };
}

const px = (im, x, y, c) => im.d[(y * im.w + x) * 4 + c];
function bilineal(im, x, y, c) {
  if (x < 0 || y < 0 || x > im.w - 1 || y > im.h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, im.w - 1), y1 = Math.min(y0 + 1, im.h - 1), fx = x - x0, fy = y - y0;
  return (px(im, x0, y0, c) * (1 - fx) + px(im, x1, y0, c) * fx) * (1 - fy) + (px(im, x0, y1, c) * (1 - fx) + px(im, x1, y1, c) * fx) * fy;
}

// Devuelve las caras (score, caja, 5 puntos: ojos, nariz, comisuras) ordenadas por score.
export async function detectar(det, im, umbral = 0.8) {
  const k = Math.min(SZ / im.w, SZ / im.h), N = SZ * SZ, t = new Float32Array(3 * N);
  for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
    const sx = x / k, sy = y / k, i = y * SZ + x;
    if (sx < im.w && sy < im.h) { t[i] = bilineal(im, sx, sy, 2); t[N + i] = bilineal(im, sx, sy, 1); t[2 * N + i] = bilineal(im, sx, sy, 0); }   // BGR 0-255
  }
  const o = await det.run({ input: new ort.Tensor("float32", t, [1, 3, SZ, SZ]) });
  const caras = [];
  for (const s of [8, 16, 32]) {
    const cols = SZ / s, rows = SZ / s, cls = o["cls_" + s].data, obj = o["obj_" + s].data, bb = o["bbox_" + s].data, kp = o["kps_" + s].data;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const sc = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (sc < umbral) continue;
      const cx = (c + bb[i * 4]) * s, cy = (r + bb[i * 4 + 1]) * s, w = Math.exp(bb[i * 4 + 2]) * s, h = Math.exp(bb[i * 4 + 3]) * s;
      const kps = [];
      for (let j = 0; j < 5; j++) kps.push([(kp[i * 10 + 2 * j] + c) * s / k, (kp[i * 10 + 2 * j + 1] + r) * s / k]);
      caras.push({ score: sc, box: [(cx - w / 2) / k, (cy - h / 2) / k, w / k, h / k], kps });
    }
  }
  caras.sort((a, b) => b.score - a.score);
  const iou = (a, b) => { const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]); const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return inter / (a[2] * a[3] + b[2] * b[3] - inter); };
  const out = [];
  for (const f of caras) if (out.every(g => iou(f.box, g.box) < 0.3)) out.push(f);
  return out;
}

// Plantilla de 5 puntos (112x112) usada por SFace/ArcFace para alinear el rostro.
const PLANTILLA = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
function similitud(src, dst) {   // transformación de similaridad (Umeyama) src -> dst
  const n = src.length; let mx = 0, my = 0, ux = 0, uy = 0;
  src.forEach(p => { mx += p[0] / n; my += p[1] / n; }); dst.forEach(p => { ux += p[0] / n; uy += p[1] / n; });
  let a = 0, b = 0, vs = 0;
  for (let i = 0; i < n; i++) { const sx = src[i][0] - mx, sy = src[i][1] - my, dx = dst[i][0] - ux, dy = dst[i][1] - uy; a += sx * dx + sy * dy; b += sx * dy - sy * dx; vs += sx * sx + sy * sy; }
  const sc = Math.hypot(a, b) / vs, th = Math.atan2(b, a), cs = sc * Math.cos(th), sn = sc * Math.sin(th);
  return [cs, -sn, ux - (cs * mx - sn * my), sn, cs, uy - (sn * mx + cs * my)];
}

// Embedding de 128 valores (normalizado) del rostro alineado a 112x112.
export async function embedding(rec, im, cara) {
  const [a, b, c, d, e, f] = similitud(cara.kps, PLANTILLA), det = a * e - b * d;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det, ic = -(ia * c + ib * f), iff = -(id * c + ie * f);
  const N = 112 * 112, t = new Float32Array(3 * N);
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const sx = ia * x + ib * y + ic, sy = id * x + ie * y + iff, i = y * 112 + x;
    t[i] = bilineal(im, sx, sy, 0); t[N + i] = bilineal(im, sx, sy, 1); t[2 * N + i] = bilineal(im, sx, sy, 2);   // RGB 0-255
  }
  const o = await rec.run({ data: new ort.Tensor("float32", t, [1, 3, 112, 112]) });
  const v = Float32Array.from(o.fc1.data);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
  return v.map(x => x / n);
}

export const coseno = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Orientación aproximada de la cabeza a partir de los 5 puntos de YuNet (imagen SIN espejo).
// giro = desplazamiento horizontal de la nariz respecto del centro de los ojos, dividido por la
// distancia entre ojos: ~0 de frente; positivo/negativo al girar (ver CONVENCION_GIRO en logica.mjs).
export function pose(cara) {
  const [ojoA, ojoB, nariz] = cara.kps;
  const cx = (ojoA[0] + ojoB[0]) / 2, cy = (ojoA[1] + ojoB[1]) / 2;
  const dOjos = Math.hypot(ojoB[0] - ojoA[0], ojoB[1] - ojoA[1]) || 1;
  return { giro: (nariz[0] - cx) / dOjos, inclinacion: (nariz[1] - cy) / dOjos, dist_ojos: dOjos };
}
