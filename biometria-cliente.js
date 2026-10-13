/* PILOTO BIOMÉTRICO — Etapa 2: verificación OPCIONAL después de un ingreso ya registrado.
   Se carga solo si el interruptor "biometria_piloto" está encendido. Para cualquier RUT que no sea
   del piloto, o sin plantilla, no muestra nada. Nunca bloquea, modifica ni borra la asistencia: el
   resultado (orientativo) lo guarda la función en su propia tabla cerrada.
   Uso: await window.BioIngreso.ejecutar({ rut, asistenciaId })  ->  "omitido" | "enviado" | "cancelado" | "error" */
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
      const d = await r.json().catch(() => ({}));
      return { status: r.status, d };
    } finally { clearTimeout(t); }
  }

  // Interfaz propia (prefijo "bioi-") para no chocar con los estilos ni ids de la app.
  function crearCapa() {
    const st = document.createElement("style");
    st.textContent = `
      #bioi-capa{position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px 12px calc(12px + env(safe-area-inset-bottom));font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0}
      #bioi-tit{font-weight:800;font-size:16px;text-align:center;max-width:420px}
      #bioi-esc{position:relative;width:100%;max-width:400px;max-height:62vh;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#0f172a}
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
    c.innerHTML = `<div id="bioi-tit">🧪 Verificación facial (piloto, opcional)</div>
      <div id="bioi-esc"><video playsinline autoplay muted></video>
        <svg viewBox="0 0 300 400" aria-hidden="true"><defs><mask id="bioi-m"><rect width="300" height="400" fill="white"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="black"/></mask></defs>
          <rect width="300" height="400" fill="rgba(15,23,42,.5)" mask="url(#bioi-m)"/><ellipse cx="150" cy="180" rx="100" ry="132" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="7 7"/></svg>
        <div id="bioi-fl"><b></b><span>Mira hacia este lado</span></div><div id="bioi-cta"></div><div id="bioi-ins"></div></div>
      <div id="bioi-msg"></div>
      <div id="bioi-btns"><button id="bioi-omitir">Omitir</button><button id="bioi-listo" class="p" disabled>Estoy listo</button></div>`;
    document.head.appendChild(st); document.body.appendChild(c);
    return { capa: c, estilo: st, $: id => c.querySelector("#" + id), video: c.querySelector("video") };
  }

  async function ejecutar({ rut, asistenciaId }) {
    if (!rut || !asistenciaId || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "omitido";
    // 1) ¿Participa? (403/503 = no es del piloto o no está configurado) — no se muestra nada.
    let r;
    try { r = await api({ accion: "precalentar", rut }, 8000); } catch (_) { return "omitido"; }
    if (r.status !== 200) return "omitido";
    // 2) ¿Tiene plantilla y la asistencia es reciente? (además empieza a cargar los modelos)
    try { r = await api({ accion: "desafio_ingreso", rut, asistencia_id: asistenciaId }); } catch (_) { return "omitido"; }
    if (r.status !== 200 || r.d.omitir) return "omitido";

    const ui = crearCapa();
    let stream = null, cancelado = false, resolverListo = null, avisarCancel = null;
    // "Omitir" corta cualquier espera (cámara arrancando, video cargando, botón "Estoy listo").
    const cancelP = new Promise((_, no) => { avisarCancel = () => no(new Error("cancelado")); });
    cancelP.catch(() => { });
    const oCancelar = p => Promise.race([p, cancelP]);
    const msg = t => { ui.$("bioi-msg").textContent = t || ""; };
    const indicar = paso => {
      const f = ui.$("bioi-fl"); f.className = "";
      if (paso === "giro_izquierda") { f.className = "izq"; f.querySelector("b").textContent = "⬅"; }
      if (paso === "giro_derecha") { f.className = "der"; f.querySelector("b").textContent = "➡"; }
    };
    const cerrar = () => {
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) { }
      stream = null; ui.capa.remove(); ui.estilo.remove();
    };
    const revisar = () => { if (cancelado) throw new Error("cancelado"); };
    ui.$("bioi-omitir").onclick = () => { cancelado = true; if (resolverListo) resolverListo(); avisarCancel(); cerrar(); };

    try {
      msg("Tu ingreso YA quedó registrado. Esta verificación es opcional y solo de apoyo.");
      const pedida = navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
      pedida.then(st => { if (cancelado) st.getTracks().forEach(t => t.stop()); }, () => { });   // si se omitió mientras arrancaba
      stream = await oCancelar(pedida);
      revisar();
      ui.video.srcObject = stream;
      await oCancelar(new Promise(res => { if (ui.video.readyState >= 2) res(); else ui.video.onloadeddata = () => res(); }));
      ui.$("bioi-ins").textContent = "Encuadra tu rostro dentro del óvalo";
      const bl = ui.$("bioi-listo"); bl.disabled = false;
      await oCancelar(new Promise(res => { resolverListo = res; bl.onclick = () => { bl.disabled = true; res(); }; }));
      revisar();
      // Desafío nuevo al pulsar "Estoy listo" (vence a los 90 s).
      msg("Preparando…");
      r = await oCancelar(api({ accion: "desafio_ingreso", rut, asistencia_id: asistenciaId })); revisar();
      if (r.status !== 200 || r.d.omitir) { cerrar(); return "omitido"; }
      const pasos = r.d.pasos, token = r.d.token, imgs = [];
      for (let i = 0; i < pasos.length; i++) {
        ui.$("bioi-ins").textContent = INSTR[pasos[i]] || pasos[i]; indicar(pasos[i]);
        if (pasos[i].startsWith("giro_")) {
          msg("Gira la cabeza (unos 30°) y mantenla hasta ver 📸"); ui.$("bioi-cta").textContent = "";
          const t = 1500 + Math.floor(Math.random() * 1500);
          for (let w = 0; w < t; w += 250) { revisar(); await esperar(250); }
        } else {
          msg("Quédate quieto mirando la cámara");
          for (let s = 3; s > 0; s--) { revisar(); ui.$("bioi-cta").textContent = s; await esperar(1000); }
        }
        revisar();
        const v = ui.video, k = Math.min(1, 480 / v.videoWidth), cv = document.createElement("canvas");
        cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
        cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);   // sin espejo
        imgs.push(cv.toDataURL("image/jpeg", 0.85).split(",")[1]);
        ui.$("bioi-cta").textContent = "📸"; await esperar(350);
      }
      indicar(null); ui.$("bioi-cta").textContent = ""; ui.$("bioi-ins").textContent = "Enviando…"; msg("");
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) { }
      r = await api({ accion: "verificar_ingreso", rut, asistencia_id: asistenciaId, token, imagenes: imgs });
      ui.$("bioi-ins").textContent = r.status === 200 ? "✔ Listo, gracias" : "No se pudo enviar (tu ingreso sigue registrado)";
      await esperar(1200); cerrar();
      return r.status === 200 ? "enviado" : "error";
    } catch (e) {
      cerrar();
      return cancelado ? "cancelado" : "error";
    }
  }

  window.BioIngreso = { ejecutar };
})();
