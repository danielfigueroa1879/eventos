/* BIOMETRÍA EN EL INGRESO (solo con el interruptor "biometria_piloto" encendido).
   Reemplaza la "Foto de verificación": la MISMA captura de frente es la foto de ingreso (se sube a R2
   como siempre) y la imagen biométrica. Primer ingreso de un RUT = enrolamiento automático; siguientes
   = verificación 1:1. Frente + UN solo giro. El consentimiento es obligatorio para continuar.
   El resultado es ORIENTATIVO (solo lo ve el admin) y nunca bloquea ni modifica la asistencia.

   API:
     await BioIngreso.capturar({ rut, fotoDesde })   // ANTES de crear la asistencia
        -> null                       (no aplica / sin cámara / servicio caído: usar la foto normal)
        (si no marca el consentimiento: "Debes aceptar" hasta 3 veces; a la 4.ª -> null = foto normal sin biometría)
        -> { cancelado: true }        (canceló la cámara: no ingresa, igual que hoy)
        -> { fotoBlob, token, imagenes }   (fotoBlob = foto de ingreso WebP, igual que la normal)
     await BioIngreso.procesar({ rut, asistenciaId, token, imagenes })   // DESPUÉS de subir la foto
*/
(() => {
  "use strict";
  if (window.BioIngreso) return;
  const API = "/.netlify/functions/biometria";
  const esperar = n => new Promise(r => setTimeout(r, n));
  const FLECHA = '<svg viewBox="0 0 84 64" aria-hidden="true"><path d="M4 22h44V6l32 26-32 26V42H4z" fill="#dc2626" stroke="#7f1d1d" stroke-width="3" stroke-linejoin="round"/></svg>';
  const INSTR = { frente: "Mira al frente", giro_izquierda: "Gira la cabeza hacia la flecha ⬅", giro_derecha: "Gira la cabeza hacia la flecha ➡" };

  async function api(cuerpo, timeoutMs = 25000, keepalive = false) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo), signal: ctl.signal, keepalive });
      return { status: r.status, d: await r.json().catch(() => ({})) };
    } finally { clearTimeout(t); }
  }

  // Interfaz propia (prefijo "bioi-") para no chocar con los estilos ni ids de la app.
  // Fondo BLANCO con letras y líneas negras: la pantalla ilumina el rostro (sirve de noche).
  function crearCapa() {
    const st = document.createElement("style");
    st.textContent = `
      #bioi-capa{position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px 12px calc(12px + env(safe-area-inset-bottom));font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}
      #bioi-tit{font-weight:800;font-size:17px;text-align:center;max-width:420px;background:rgba(255,255,255,.88);padding:6px 14px;border-radius:999px}
      /* Fuera de los recuadros: la MISMA imagen de fondo de la app (desenfocada, con velo claro).
         La tarjeta del aviso es blanca y el recuadro de la cámara es BLANCO 100% (ilumina el rostro). */
      #bioi-capa,#bioi-capa.cons{background:#e5e9ee;overflow:hidden;isolation:isolate}
      #bioi-capa::before{content:"";position:absolute;inset:-12px;z-index:-1;background:linear-gradient(rgba(238,242,240,.6),rgba(238,242,240,.6)),url("images/fondo.webp") center/cover no-repeat;filter:blur(3px)}
      #bioi-cons{max-width:420px;width:100%;background:#fff;border:1px solid #cbd5e1;border-radius:16px;font-size:14.5px;overflow:hidden;box-shadow:0 10px 30px -10px rgba(15,23,42,.35)}
      #bioi-cons .cab{background:#0f5323;color:#fff;font-weight:800;font-size:16px;padding:12px 16px}
      #bioi-cons .cue{padding:14px 16px 16px}
      #bioi-cons p{margin:0 0 10px;color:#1e293b}#bioi-cons small{color:#475569;font-size:12px}
      #bioi-chk{display:flex;gap:12px;align-items:center;margin-top:14px;padding:14px;border:2.5px solid #0f5323;border-radius:12px;background:#f0fdf4;cursor:pointer;font-weight:800;font-size:16px;color:#0f5323}
      #bioi-chk:has(input:checked){background:#bbf7d0}
      #bioi-chk.mal{border-color:#dc2626;background:#fef2f2;color:#991b1b}
      #bioi-chk input{width:30px;height:30px;flex-shrink:0;margin:0;accent-color:#0f5323}
      #bioi-aviso{display:none;margin-top:12px;padding:10px 12px;border-radius:10px;background:#dc2626;color:#fff;font-weight:800;font-size:14.5px;text-align:center}
      #bioi-aviso.on{display:block;animation:bioiSac .4s}
      @keyframes bioiSac{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
      #bioi-esc{position:relative;width:100%;max-width:400px;max-height:62vh;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#fff;display:none;box-shadow:0 10px 30px -10px rgba(15,23,42,.35)}
      #bioi-esc video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
      #bioi-esc svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
      #bioi-ins{position:absolute;left:0;right:0;top:0;padding:12px 10px 18px;text-align:center;color:#0f172a;font-weight:800;font-size:18px;background:linear-gradient(rgba(255,255,255,.97),rgba(255,255,255,0))}
      #bioi-cta{position:absolute;left:0;right:0;bottom:14px;text-align:center;color:#0f172a;font-size:50px;font-weight:900;text-shadow:0 0 8px #fff}
      #bioi-fl{position:absolute;top:50%;transform:translateY(-50%);display:none;flex-direction:column;align-items:center;gap:4px;color:#ea580c;text-shadow:0 0 6px #fff;pointer-events:none}
      /* Flecha dibujada (SVG), ROJA y del mismo grosor a ambos lados y en todos los intentos (antes era
         un carácter que cada celular dibujaba distinto). La izquierda es la misma flecha espejada. */
      #bioi-fl b{display:block;width:84px;height:64px;line-height:0}#bioi-fl b svg{width:100%;height:100%;filter:drop-shadow(0 0 3px #fff) drop-shadow(0 2px 4px rgba(0,0,0,.35))}
      #bioi-fl.izq b svg{transform:scaleX(-1)}#bioi-fl span{font-size:13px;font-weight:800;background:#0f172a;padding:4px 8px;border-radius:8px;color:#fff;white-space:nowrap}
      #bioi-fl.izq{display:flex;left:6px}#bioi-fl.der{display:flex;right:6px}
      #bioi-fl.izq b{animation:bioiI .9s ease-in-out infinite}#bioi-fl.der b{animation:bioiD .9s ease-in-out infinite}
      @keyframes bioiI{50%{transform:translateX(-14px)}}@keyframes bioiD{50%{transform:translateX(14px)}}
      /* GUÍA REFORZADA (2.º intento o más): borde que destella del lado del giro y una
         cabeza animada que gira hacia ese lado. */
      #bioi-guia{position:absolute;inset:0;pointer-events:none;display:none}
      #bioi-guia.izq,#bioi-guia.der{display:block}
      #bioi-guia .borde{position:absolute;top:0;bottom:0;width:26%;animation:bioiDest .7s ease-in-out infinite}
      #bioi-guia.izq .borde{left:0;background:linear-gradient(to right,rgba(245,158,11,.85),rgba(245,158,11,0))}
      #bioi-guia.der .borde{right:0;background:linear-gradient(to left,rgba(245,158,11,.85),rgba(245,158,11,0))}
      /* Cabeza guía ABAJO (debajo del óvalo, sin tapar el rostro): gira hacia el lado de la flecha. */
      #bioi-guia .cab{position:absolute;bottom:6px;left:50%;width:66px;height:66px;margin-left:-33px;background:rgba(15,23,42,.7);border-radius:50%;border:2px solid #facc15}
      #bioi-guia .cab svg{width:100%;height:100%;overflow:visible}
      #bioi-guia.izq .cara{animation:bioiCabI 1.6s ease-in-out infinite}#bioi-guia.der .cara{animation:bioiCabD 1.6s ease-in-out infinite}
      #bioi-guia .oreja{opacity:0}#bioi-guia.izq .oreja.d{animation:bioiOreja 1.6s ease-in-out infinite}#bioi-guia.der .oreja.i{animation:bioiOreja 1.6s ease-in-out infinite}
      #bioi-guia.izq .craneo{animation:bioiCrI 1.6s ease-in-out infinite}#bioi-guia.der .craneo{animation:bioiCrD 1.6s ease-in-out infinite}
      @keyframes bioiDest{50%{opacity:.25}}
      @keyframes bioiCabI{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(-12px)}100%{transform:translateX(0)}}
      @keyframes bioiCabD{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(12px)}100%{transform:translateX(0)}}
      @keyframes bioiCrI{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(-3px)}100%{transform:translateX(0)}}
      @keyframes bioiCrD{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(3px)}100%{transform:translateX(0)}}
      @keyframes bioiOreja{0%,15%{opacity:0}45%,85%{opacity:1}100%{opacity:0}}
      #bioi-msg{font-size:14px;text-align:center;max-width:420px;min-height:20px;background:rgba(255,255,255,.88);padding:6px 12px;border-radius:10px}#bioi-msg:empty{background:none}
      #bioi-btns{display:flex;gap:10px;width:100%;max-width:420px}
      #bioi-btns button{flex:1;padding:14px;font-size:16px;font-weight:700;border-radius:10px;border:1.5px solid #0f172a;background:#fff;color:#0f172a}
      #bioi-btns button.p{background:#0f5323;border-color:#0f5323;color:#fff}#bioi-btns button:disabled{opacity:.45}`;
    const c = document.createElement("div");
    c.id = "bioi-capa"; c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true");
    c.innerHTML = `<div id="bioi-tit">📸 Foto y verificación facial</div>
      <div id="bioi-cons"></div>
      <div id="bioi-esc"><video playsinline autoplay muted></video>
        <svg viewBox="0 0 300 400" aria-hidden="true"><defs><mask id="bioi-m"><rect width="300" height="400" fill="white"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="black"/></mask></defs>
          <rect width="300" height="400" fill="#ffffff" mask="url(#bioi-m)"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="none" stroke="#0f172a" stroke-width="3" stroke-dasharray="7 7"/></svg>
        <div id="bioi-guia"><div class="borde"></div>
          <div class="cab"><svg viewBox="0 0 92 92"><g class="craneo"><ellipse class="oreja i" cx="20" cy="49" rx="5" ry="8" fill="#f59e0b"/><ellipse class="oreja d" cx="72" cy="49" rx="5" ry="8" fill="#f59e0b"/><ellipse cx="46" cy="48" rx="26" ry="31" fill="#fcd34d"/></g><g class="cara"><circle cx="37" cy="42" r="3.6" fill="#111827"/><circle cx="55" cy="42" r="3.6" fill="#111827"/><path d="M46 46 l-4 11 h8z" fill="#b45309"/><path d="M38 63 q8 5 16 0" stroke="#111827" stroke-width="2.6" fill="none" stroke-linecap="round"/></g></svg></div></div>
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

  // Despierta la función (carga de modelos) por adelantado. Máximo una vez por minuto.
  let ultimoCalentar = 0;
  function precalentar(rut) {
    if (!rut || Date.now() - ultimoCalentar < 60000) return;
    ultimoCalentar = Date.now();
    api({ accion: "precalentar", rut }, 15000).catch(() => { });
  }

  async function capturar({ rut, fotoDesde, reintento }) {
    if (!rut || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    // ¿Aplica? (403/503 = no participa o servicio no configurado -> foto normal). Empieza a cargar los modelos.
    precalentar(rut);
    // VELOCIDAD: la pantalla de consentimiento se muestra AL TIRO; el desafío se pide en paralelo.
    let r, tDesafio = 0;
    const pDesafio = api({ accion: "desafio_auto", rut }, 10000).catch(() => ({ status: 0 })).then(x => { r = x; tDesafio = Date.now(); return x; });
    const textos = pv => ({ tit: pv ? "Primer registro con verificación facial" : "Verificación facial", acc: pv ? "crear" : "comparar con" });

    const ui = crearCapa();
    let stream = null;
    const msg = t => { ui.$("bioi-msg").textContent = t || ""; };
    const indicar = paso => {
      const f = ui.$("bioi-fl"), g = ui.$("bioi-guia"); f.className = ""; g.className = "";
      const lado = paso === "giro_izquierda" ? "izq" : paso === "giro_derecha" ? "der" : "";
      if (lado) { f.className = lado; f.querySelector("b").innerHTML = FLECHA; }
      // 2.º intento o más: guía reforzada (borde que destella y cabeza animada abajo).
      if (lado && reintento) {
        g.className = lado;
        try { navigator.vibrate && navigator.vibrate([120, 80, 120]); } catch (_) { }
      }
    };
    const cerrar = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) { } stream = null; ui.capa.remove(); ui.estilo.remove(); };

    try {
      // 1) Consentimiento: una casilla. Sin marcarla, "Debes aceptar" (hasta 3 veces); a la 4.ª vez se
      //    sigue SOLO con la foto normal (sin biometría): se devuelve null y la app usa la foto de siempre.
      const t0 = textos(false);
      ui.capa.classList.add("cons");
      ui.$("bioi-cons").innerHTML = `<div class="cab">🔒 <span id="bioi-ctit">${t0.tit}</span></div><div class="cue">
        <p>Tu foto de ingreso se usará también para <span id="bioi-acc">${t0.acc}</span> una plantilla biométrica cifrada de tu rostro, solo para verificar tu identidad en los ingresos a eventos.</p>
        <p>No se usa para identificar a otras personas y puedes pedir su eliminación al administrador.</p>
        <small>Ley N° 19.628 y Ley N° 21.719 (datos sensibles).</small>
        <label id="bioi-chk"><input type="checkbox" id="bioi-acepto"><span>Acepto la verificación facial</span></label>
        <div id="bioi-aviso"></div></div>`;
      ui.$("bioi-acepto").addEventListener("change", () => { ui.$("bioi-chk").classList.remove("mal"); ui.$("bioi-aviso").classList.remove("on"); });
      ui.$("bioi-no").style.display = "none";
      pDesafio.then(x => { if (x.status === 200 && x.d.modo === "enrolamiento") { const t = textos(true); ui.$("bioi-ctit").textContent = t.tit; ui.$("bioi-acc").textContent = t.acc; } });
      let intentos = 0;
      for (;;) {
        await elegir(ui, "Continuar", "");
        if (ui.$("bioi-acepto").checked) break;
        intentos++;
        if (intentos >= 4) { cerrar(); return null; }   // 4.ª vez sin aceptar: solo la foto normal
        const av = ui.$("bioi-aviso"); av.classList.remove("on"); void av.offsetWidth;   // reinicia la animación
        av.textContent = `⚠ Debes marcar la casilla para continuar.${intentos === 3 ? " (último aviso)" : ""}`;
        av.classList.add("on"); ui.$("bioi-chk").classList.add("mal");
      }
      ui.$("bioi-no").style.display = "";
      // ¿Aplica? (403/503 = no participa o servicio no configurado -> foto normal).
      if (!r) { msg("Preparando…"); await pDesafio; }
      if (r.status !== 200 || !r.d.pasos) { cerrar(); return null; }
      // 2) Cámara.
      ui.capa.classList.remove("cons");   // cámara: el recuadro del óvalo es BLANCO (ilumina el rostro)
      ui.$("bioi-cons").style.display = "none"; ui.$("bioi-esc").style.display = "block";
      ui.$("bioi-no").textContent = "Cancelar"; msg("Abriendo cámara…");
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } }, audio: false }); }
      catch (_) { cerrar(); return null; }   // sin cámara o sin permiso: se usa la foto normal
      ui.video.srcObject = stream;
      await new Promise(res => { if (ui.video.readyState >= 2) res(); else ui.video.onloadeddata = () => res(); });
      ui.$("bioi-ins").textContent = "Encuadra tu rostro dentro del óvalo";
      msg(reintento
        ? "Esta vez: primero mira al frente; cuando se ilumine un lado, GIRA la cabeza hacia ese lado (como la carita de abajo) y quédate así hasta ver 📸."
        : "Con buena luz y de frente. Cuando estés listo, pulsa el botón.");
      if (!(await elegir(ui, "Estoy listo", "Cancelar"))) { cerrar(); return { cancelado: true }; }
      ui.$("bioi-no").disabled = true;

      // 3) Desafío nuevo (vence a los 90 s): frente + 1 giro.
      // Se reutiliza el primer desafío si le quedan > 45 s (vence a los 90 s): una consulta menos.
      if (Date.now() - tDesafio > 45000) {
        msg("Preparando…");
        try { r = await api({ accion: "desafio_auto", rut }, 10000); } catch (_) { r = { status: 0 }; }
      }
      const pasos = r.status === 200 && r.d.pasos ? r.d.pasos : ["frente"];   // si falla, al menos la foto de frente
      const token = r.status === 200 ? r.d.token : null;
      const imgs = []; let fotoBlob = null;
      for (let i = 0; i < pasos.length; i++) {
        ui.$("bioi-ins").textContent = INSTR[pasos[i]] || pasos[i]; indicar(pasos[i]);
        if (pasos[i].startsWith("giro_")) {
          msg("Gira la cabeza (unos 30°) y mantenla hasta ver 📸"); ui.$("bioi-cta").textContent = "";
          // Momento de captura aleatorio; en el reintento, un poco más de tiempo para girar.
          await esperar((reintento ? 1800 : 1000) + Math.floor(Math.random() * 1000));
        } else {
          msg("Quédate quieto mirando la cámara");
          for (let s = 2; s > 0; s--) { ui.$("bioi-cta").textContent = s; await esperar(900); }
        }
        const v = ui.video, k = Math.min(1, 480 / v.videoWidth), cv = document.createElement("canvas");
        cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
        cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);   // sin espejo
        imgs.push(cv.toDataURL("image/jpeg", 0.85).split(",")[1]);
        // La captura de FRENTE es también la foto de ingreso (mismo proceso que la foto normal: WebP 3:4).
        if (pasos[i] === "frente" && !fotoBlob) { try { fotoBlob = await fotoDesde(v); } catch (_) { fotoBlob = null; } }
        ui.$("bioi-cta").textContent = "📸"; await esperar(250);
      }
      cerrar();
      if (!fotoBlob) return null;   // no se pudo generar la foto: se usa la foto normal
      return { fotoBlob, token, imagenes: token ? imgs : null, modo: r.status === 200 ? r.d.modo : null };
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

  // Revisión ANTES de registrar. Devuelve { estado }: "bloqueado" (otra persona: no registrar),
  // "repetir" (prueba de vida no superada: repetir, con una pista), "ok" (registrar) o "error"
  // (sin señal / falla: se registra igual, como antes). En el primer ingreso solo revisa la prueba de vida.
  async function verificarPrevio({ rut, token, imagenes }) {
    if (!token || !imagenes) return { estado: "error" };
    try {
      const r = await api({ accion: "procesar_auto", previo: true, rut, token, imagenes, consentimiento: true }, 30000);
      if (r.status !== 200) return { estado: "error" };
      if (r.d.reintentar) return { estado: "repetir", pista: r.d.pista || "" };
      return { estado: r.d.bloqueado ? "bloqueado" : "ok" };
    } catch (_) { return { estado: "error" }; }
  }
  // Asocia la verificación previa a la asistencia recién creada (para las palomas del panel).
  async function vincular({ rut, token, asistenciaId, enSegundoPlano }) {
    if (!token || !asistenciaId) return "omitido";
    try { const r = await api({ accion: "vincular", rut, token, asistencia_id: asistenciaId }, 15000, !!enSegundoPlano); return r.status === 200 && r.d.vinculado ? "ok" : "error"; }
    catch (_) { return "error"; }
  }

  window.BioIngreso = { capturar, procesar, verificarPrevio, vincular, precalentar };
})();
