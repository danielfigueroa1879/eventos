/* BIOMETRÍA EN EL INGRESO (solo con el interruptor "biometria_piloto" encendido).
   Reemplaza la "Foto de verificación": la MISMA captura de frente es la foto de ingreso (se sube a R2
   como siempre) y la imagen biométrica. Primer ingreso de un RUT = enrolamiento automático; siguientes
   = verificación 1:1. Frente + UN solo giro. El consentimiento es obligatorio para continuar.
   El resultado es ORIENTATIVO (solo lo ve el admin) y nunca bloquea ni modifica la asistencia.

   API:
     await BioIngreso.capturar({ rut, fotoDesde })   // ANTES de crear la asistencia
        -> null                       (no aplica / sin cámara / servicio caído: usar la foto normal)
        -> { rechazo: true }          (no aceptó el consentimiento: no ingresa)
        -> { cancelado: true }        (canceló la cámara: no ingresa, igual que hoy)
        -> { fotoBlob, token, imagenes }   (fotoBlob = foto de ingreso WebP, igual que la normal)
     await BioIngreso.procesar({ rut, asistenciaId, token, imagenes })   // DESPUÉS de subir la foto
*/
(() => {
  "use strict";
  if (window.BioIngreso) return;
  const API = "/.netlify/functions/biometria";
  const esperar = n => new Promise(r => setTimeout(r, n));
  const INSTR = { frente: "Mira al frente", giro_izquierda: "Gira la cabeza hacia la flecha ⬅", giro_derecha: "Gira la cabeza hacia la flecha ➡" };

  async function api(cuerpo, timeoutMs = 25000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo), signal: ctl.signal });
      return { status: r.status, d: await r.json().catch(() => ({})) };
    } finally { clearTimeout(t); }
  }

  // Interfaz propia (prefijo "bioi-") para no chocar con los estilos ni ids de la app.
  function crearCapa() {
    const st = document.createElement("style");
    st.textContent = `
      #bioi-capa{position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px 12px calc(12px + env(safe-area-inset-bottom));font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0}
      #bioi-tit{font-weight:800;font-size:17px;text-align:center;max-width:420px}
      #bioi-cons{max-width:420px;background:#0f172a;border:1px solid #334155;border-radius:14px;padding:16px;font-size:14px}
      #bioi-cons p{margin:0 0 10px}#bioi-cons small{color:#94a3b8;font-size:12px}
      #bioi-esc{position:relative;width:100%;max-width:400px;max-height:62vh;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#0f172a;display:none}
      #bioi-esc video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
      #bioi-esc svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      #bioi-ins{position:absolute;left:0;right:0;top:0;padding:12px 10px 18px;text-align:center;color:#fff;font-weight:800;font-size:18px;background:linear-gradient(rgba(0,0,0,.75),transparent)}
      #bioi-cta{position:absolute;left:0;right:0;bottom:14px;text-align:center;color:#fff;font-size:50px;font-weight:900;text-shadow:0 2px 8px #000}
      #bioi-fl{position:absolute;top:50%;transform:translateY(-50%);display:none;flex-direction:column;align-items:center;gap:4px;color:#fde047;text-shadow:0 2px 10px #000;pointer-events:none}
      #bioi-fl b{font-size:88px;line-height:1}#bioi-fl span{font-size:13px;font-weight:800;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:8px;color:#fff;white-space:nowrap}
      #bioi-fl.izq{display:flex;left:6px}#bioi-fl.der{display:flex;right:6px}
      #bioi-fl.izq b{animation:bioiI .9s ease-in-out infinite}#bioi-fl.der b{animation:bioiD .9s ease-in-out infinite}
      @keyframes bioiI{50%{transform:translateX(-14px)}}@keyframes bioiD{50%{transform:translateX(14px)}}
      #bioi-msg{font-size:14px;text-align:center;max-width:420px;min-height:20px}
      #bioi-btns{display:flex;gap:10px;width:100%;max-width:420px}
      #bioi-btns button{flex:1;padding:14px;font-size:16px;font-weight:700;border-radius:10px;border:1px solid #475569;background:transparent;color:#fff}
      #bioi-btns button.p{background:#0f5323;border-color:#0f5323}#bioi-btns button:disabled{opacity:.45}`;
    const c = document.createElement("div");
    c.id = "bioi-capa"; c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true");
    c.innerHTML = `<div id="bioi-tit">📸 Foto y verificación facial</div>
      <div id="bioi-cons"></div>
      <div id="bioi-esc"><video playsinline autoplay muted></video>
        <svg viewBox="0 0 300 400" aria-hidden="true"><defs><mask id="bioi-m"><rect width="300" height="400" fill="white"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="black"/></mask></defs>
          <rect width="300" height="400" fill="rgba(15,23,42,.5)" mask="url(#bioi-m)"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="7 7"/></svg>
        <div id="bioi-fl"><b></b><span>Mira hacia este lado</span></div><div id="bioi-cta"></div><div id="bioi-ins"></div></div>
      <div id="bioi-msg"></div>
      <div id="bioi-btns"><button id="bioi-no">Cancelar</button><button id="bioi-si" class="p">Continuar</button></div>`;
    document.head.appendChild(st); document.body.appendChild(c);
    return { capa: c, estilo: st, $: id => c.querySelector("#" + id), video: c.querySelector("video") };
  }
  // Espera a que se pulse uno de los dos botones: true = principal, false = secundario.
  function elegir(ui, txtSi, txtNo) {
    const si = ui.$("bioi-si"), no = ui.$("bioi-no");
    si.textContent = txtSi; no.textContent = txtNo; si.disabled = false; no.disabled = false;
    return new Promise(res => { si.onclick = () => { si.disabled = true; res(true); }; no.onclick = () => res(false); });
  }

  async function capturar({ rut, fotoDesde }) {
    if (!rut || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    // ¿Aplica? (403/503 = no participa o servicio no configurado -> foto normal). Empieza a cargar los modelos.
    api({ accion: "precalentar", rut }, 15000).catch(() => { });
    let r;
    try { r = await api({ accion: "desafio_auto", rut }, 10000); } catch (_) { return null; }
    if (r.status !== 200 || !r.d.pasos) return null;
    const primeraVez = r.d.modo === "enrolamiento";

    const ui = crearCapa();
    let stream = null;
    const msg = t => { ui.$("bioi-msg").textContent = t || ""; };
    const indicar = paso => {
      const f = ui.$("bioi-fl"); f.className = "";
      if (paso === "giro_izquierda") { f.className = "izq"; f.querySelector("b").textContent = "⬅"; }
      if (paso === "giro_derecha") { f.className = "der"; f.querySelector("b").textContent = "➡"; }
    };
    const cerrar = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) { } stream = null; ui.capa.remove(); ui.estilo.remove(); };

    try {
      // 1) Consentimiento OBLIGATORIO para continuar.
      ui.$("bioi-cons").innerHTML = `<p><b>${primeraVez ? "Primer registro con verificación facial" : "Verificación facial"}</b></p>
        <p>Tu foto de ingreso se usará también para ${primeraVez ? "crear" : "comparar con"} una plantilla biométrica cifrada de tu rostro, solo para verificar tu identidad en los ingresos a eventos.</p>
        <p>No se usa para identificar a otras personas y puedes pedir su eliminación al administrador.</p>
        <small>Ley N° 19.628 y Ley N° 21.719 (datos sensibles). Para continuar con tu ingreso debes aceptar.</small>`;
      if (!(await elegir(ui, "Acepto y continuar", "No acepto"))) { cerrar(); return { rechazo: true }; }

      // 2) Cámara.
      ui.$("bioi-cons").style.display = "none"; ui.$("bioi-esc").style.display = "block";
      ui.$("bioi-no").textContent = "Cancelar"; msg("Abriendo cámara…");
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } }, audio: false }); }
      catch (_) { cerrar(); return null; }   // sin cámara o sin permiso: se usa la foto normal
      ui.video.srcObject = stream;
      await new Promise(res => { if (ui.video.readyState >= 2) res(); else ui.video.onloadeddata = () => res(); });
      ui.$("bioi-ins").textContent = "Encuadra tu rostro dentro del óvalo";
      msg("Con buena luz y de frente. Cuando estés listo, pulsa el botón.");
      if (!(await elegir(ui, "Estoy listo", "Cancelar"))) { cerrar(); return { cancelado: true }; }
      ui.$("bioi-no").disabled = true;

      // 3) Desafío nuevo (vence a los 90 s): frente + 1 giro.
      msg("Preparando…");
      try { r = await api({ accion: "desafio_auto", rut }, 10000); } catch (_) { r = { status: 0 }; }
      const pasos = r.status === 200 && r.d.pasos ? r.d.pasos : ["frente"];   // si falla, al menos la foto de frente
      const token = r.status === 200 ? r.d.token : null;
      const imgs = []; let fotoBlob = null;
      for (let i = 0; i < pasos.length; i++) {
        ui.$("bioi-ins").textContent = INSTR[pasos[i]] || pasos[i]; indicar(pasos[i]);
        if (pasos[i].startsWith("giro_")) {
          msg("Gira la cabeza (unos 30°) y mantenla hasta ver 📸"); ui.$("bioi-cta").textContent = "";
          await esperar(1500 + Math.floor(Math.random() * 1500));   // momento de captura aleatorio
        } else {
          msg("Quédate quieto mirando la cámara");
          for (let s = 3; s > 0; s--) { ui.$("bioi-cta").textContent = s; await esperar(1000); }
        }
        const v = ui.video, k = Math.min(1, 480 / v.videoWidth), cv = document.createElement("canvas");
        cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
        cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);   // sin espejo
        imgs.push(cv.toDataURL("image/jpeg", 0.85).split(",")[1]);
        // La captura de FRENTE es también la foto de ingreso (mismo proceso que la foto normal: WebP 3:4).
        if (pasos[i] === "frente" && !fotoBlob) { try { fotoBlob = await fotoDesde(v); } catch (_) { fotoBlob = null; } }
        ui.$("bioi-cta").textContent = "📸"; await esperar(350);
      }
      cerrar();
      if (!fotoBlob) return null;   // no se pudo generar la foto: se usa la foto normal
      return { fotoBlob, token, imagenes: token ? imgs : null };
    } catch (e) {
      cerrar();
      return null;
    }
  }

  // Envía las capturas a la función (enrola o verifica). Nunca lanza error: el ingreso ya está guardado.
  async function procesar({ rut, asistenciaId, token, imagenes }) {
    if (!token || !imagenes || !asistenciaId) return "omitido";
    try {
      const r = await api({ accion: "procesar_auto", rut, asistencia_id: asistenciaId, token, imagenes, consentimiento: true }, 30000);
      return r.status === 200 ? (r.d.resultado || "ok") : "error";
    } catch (_) { return "error"; }
  }

  window.BioIngreso = { capturar, procesar };
})();
