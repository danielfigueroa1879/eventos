/* BIOMETRÍA EN EL INGRESO (solo con el interruptor "biometria_piloto" encendido).
   Reemplaza la "Foto de verificación": la MISMA captura de frente es la foto de ingreso (se sube a R2
   como siempre) y la imagen biométrica. Primer ingreso de un RUT = enrolamiento automático; siguientes
   = verificación 1:1. Frente + UN solo giro. El consentimiento es obligatorio para continuar.
   El resultado es ORIENTATIVO (solo lo ve el admin) y nunca bloquea ni modifica la asistencia.

   API:
     await BioIngreso.capturar({ rut, fotoDesde })   // ANTES de crear la asistencia
        -> null                       (no aplica / sin cámara / servicio caído: usar la foto normal)
        (consentimiento de un toque: el botón "Acepto y continúo"; sin pulsarlo no se registra el ingreso)
        -> { cancelado: true }        (canceló la cámara: no ingresa, igual que hoy)
        -> { sinCamara: true }        (la cámara no abre o no da imagen, p. ej. link abierto dentro de WhatsApp:
                                        NO ingresa; la app le indica escanear el QR con la cámara del teléfono)
        -> { fotoBlob, token, imagenes }   (fotoBlob = foto de ingreso WebP, igual que la normal)
     await BioIngreso.procesar({ rut, asistenciaId, token, imagenes })   // DESPUÉS de subir la foto
*/
(() => {
  "use strict";
  if (window.BioIngreso) return;
  const API = "/.netlify/functions/biometria";
  const esperar = n => new Promise(r => setTimeout(r, n));
  // Misma forma que la flecha de antes (cuerpo grueso y cabeza corta), pero ROJA.
  const FLECHA = '<svg viewBox="0 0 84 60" aria-hidden="true"><path d="M0 13H56V0L84 30 56 60V47H0Z" fill="#dc2626"/></svg>';
  // Ícono estilo Face ID (dibujado en SVG: se ve igual en todos los celulares). Marco fijo + rasgos que se
  // desplazan hacia el lado de la flecha durante el giro.
  const FACE_ID = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M22 8H14a6 6 0 0 0-6 6v8M42 8h8a6 6 0 0 1 6 6v8M22 56H14a6 6 0 0 1-6-6v-8M42 56h8a6 6 0 0 0 6-6v-8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><g class="fid-cara"><path d="M22 27v-3M42 27v-3M32 23v13c0 3-2 5-5 5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><path d="M22 43c3 4 7 6 10 6s7-2 10-6" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></g></svg>';
  const INSTR = { frente: "Mira al frente", giro_izquierda: "⬅ Gira la cabeza hacia la flecha", giro_derecha: "Gira la cabeza hacia la flecha ➡" };

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
      #bioi-ovalo{transition:stroke .45s ease,stroke-width .45s ease,filter .45s ease}
      #bioi-ins{position:absolute;left:0;right:0;top:0;padding:12px 10px 18px;text-align:center;color:#0f172a;font-weight:800;font-size:17px;line-height:1.25;background:linear-gradient(rgba(255,255,255,.97),rgba(255,255,255,0))}
      #bioi-cta{position:absolute;left:0;right:0;bottom:78px;text-align:center;color:#0f172a;font-size:50px;font-weight:900;text-shadow:0 0 8px #fff}#bioi-cta svg{width:52px;height:52px;display:inline-block;vertical-align:middle;filter:drop-shadow(0 0 6px #fff)}
      #bioi-fl{position:absolute;top:50%;transform:translateY(-50%);display:none;flex-direction:column;align-items:center;gap:4px;color:#ea580c;text-shadow:0 0 6px #fff;pointer-events:none}
      /* Flecha dibujada (SVG), ROJA y del mismo grosor a ambos lados y en todos los intentos (antes era
         un carácter que cada celular dibujaba distinto). La izquierda es la misma flecha espejada. */
      #bioi-fl b{display:block;width:84px;height:60px;line-height:0}#bioi-fl b svg{width:100%;height:100%;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 2px #fff)}
      #bioi-fl.izq b svg{transform:scaleX(-1)}#bioi-fl span{font-size:13px;font-weight:800;background:#0f172a;padding:4px 8px;border-radius:8px;color:#fff;white-space:nowrap}
      #bioi-fl.izq{display:flex;left:6px}#bioi-fl.der{display:flex;right:6px}
      #bioi-fl.izq b{animation:bioiI .9s ease-in-out infinite}#bioi-fl.der b{animation:bioiD .9s ease-in-out infinite}
      /* El contenedor permanece BLANCO para iluminar el rostro. Solo cambia el óvalo segmentado. */
      #bioi-ovalo{transition:stroke .16s linear,stroke-width .16s linear,filter .16s linear}
      #bioi-esc.ok-giro #bioi-ovalo{stroke:#22c55e!important;stroke-width:7!important;filter:drop-shadow(0 0 10px #22c55e);animation:bioiOkFlash .42s ease-out}
      #bioi-esc.ok-giro #bioi-fl b svg path{fill:#22c55e!important}
      #bioi-esc.ok-giro #bioi-fl span{background:#16a34a;color:#fff;font-size:15px}
      #bioi-esc.ok-giro #bioi-ins{color:#14532d}
      #bioi-esc.ok-giro #bioi-cta{color:#16a34a;font-size:38px;text-shadow:0 0 10px #fff,0 0 18px #22c55e}
      @keyframes bioiOkFlash{0%{filter:drop-shadow(0 0 2px #22c55e)}45%{filter:drop-shadow(0 0 22px #22c55e)}100%{filter:drop-shadow(0 0 10px #22c55e)}}
      @keyframes bioiI{50%{transform:translateX(-14px)}}@keyframes bioiD{50%{transform:translateX(14px)}}
      /* GUÍA REFORZADA (2.º intento o más): borde que destella del lado del giro y una
         cabeza animada que gira hacia ese lado. */
      #bioi-guia{position:absolute;inset:0;pointer-events:none;display:none}
      #bioi-guia.izq,#bioi-guia.der{display:block}
      #bioi-guia .borde{position:absolute;top:0;bottom:0;width:26%;animation:bioiDest .7s ease-in-out infinite}
      #bioi-guia.izq .borde{left:0;background:linear-gradient(to right,rgba(245,158,11,.85),rgba(245,158,11,0))}
      #bioi-guia.der .borde{right:0;background:linear-gradient(to left,rgba(245,158,11,.85),rgba(245,158,11,0))}
      /* Cabeza guía ABAJO (debajo del óvalo, sin tapar el rostro): gira hacia el lado de la flecha. */
      /* Ícono Face ID: centrado ABAJO del óvalo, visible en todos los pasos y en todos los intentos.
         Gira (rasgos hacia la flecha) en el paso de giro y se pone VERDE al capturar / giro correcto. */
      #bioi-fid{position:absolute;bottom:8px;left:50%;width:60px;height:60px;margin-left:-30px;color:#0f172a;background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(15,23,42,.18);padding:4px;pointer-events:none;transition:color .2s}
      #bioi-fid svg{position:static;width:100%;height:100%;display:block;overflow:visible}
      #bioi-fid.izq .fid-cara{animation:bioiFidI 1.6s ease-in-out infinite}#bioi-fid.der .fid-cara{animation:bioiFidD 1.6s ease-in-out infinite}
      #bioi-fid.ok{color:#16a34a;animation:bioiFidOk .35s ease-out}#bioi-fid.ok .fid-cara{animation:none}
      @keyframes bioiFidI{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(-7px)}100%{transform:translateX(0)}}
      @keyframes bioiFidD{0%,15%{transform:translateX(0)}45%,85%{transform:translateX(7px)}100%{transform:translateX(0)}}
      @keyframes bioiFidOk{50%{transform:scale(1.15)}}
      @keyframes bioiDest{50%{opacity:.25}}
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
          <rect width="300" height="400" fill="#ffffff" mask="url(#bioi-m)"/><ellipse id="bioi-ovalo" cx="150" cy="180" rx="100" ry="132" fill="none" stroke="#0f172a" stroke-width="5"/></svg>
        <div id="bioi-guia"><div class="borde"></div>
</div>
        <div id="bioi-fl"><b></b><span>Gira hacia aquí</span></div><div id="bioi-fid">${FACE_ID}</div><div id="bioi-cta"></div><div id="bioi-ins"></div></div>
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
    if (!rut) return null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { sinCamara: true };   // navegador sin cámara (p. ej. dentro de una app)
    // ¿Aplica? (403/503 = no participa o servicio no configurado -> foto normal). Empieza a cargar los modelos.
    precalentar(rut);
    // VELOCIDAD: la pantalla de consentimiento se muestra AL TIRO; el desafío se pide en paralelo.
    let r, tDesafio = 0;
    const pDesafio = api({ accion: "desafio_auto", rut }, 10000).catch(() => ({ status: 0 })).then(x => { r = x; tDesafio = Date.now(); return x; });
    const textos = pv => ({ tit: pv ? "Primer registro con verificación facial" : "Verificación facial", acc: pv ? "crear" : "comparar con" });

    const ui = crearCapa();
    let stream = null;
    const msg = t => { ui.$("bioi-msg").textContent = t || ""; };
    const msgHtml = h => { ui.$("bioi-msg").innerHTML = h; };   // solo textos fijos de este archivo
    const indicar = paso => {
      const f = ui.$("bioi-fl"), g = ui.$("bioi-guia"); f.className = ""; g.className = "";
      ui.$("bioi-esc").classList.remove("ok-giro");
      const ovalo = ui.$("bioi-ovalo");
      ovalo.style.stroke = "#0f172a"; ovalo.style.strokeWidth = "5"; ovalo.style.filter = "";
      const lado = paso === "giro_izquierda" ? "izq" : paso === "giro_derecha" ? "der" : "";
      if (lado) { f.className = lado; f.querySelector("b").innerHTML = FLECHA; }
      ui.$("bioi-fid").className = lado;   // Face ID: gira hacia la flecha (o queda de frente)
      // 2.º intento o más: guía reforzada (borde que destella y cabeza animada abajo).
      if (lado && reintento) {
        g.className = lado;
        try { navigator.vibrate && navigator.vibrate([120, 80, 120]); } catch (_) { }
      }
    };
    const cerrar = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) { } stream = null; ui.capa.remove(); ui.estilo.remove(); };

    // Frame liviano para la guía EN VIVO. No se guarda: el servidor devuelve solo pose/encuadre.
    const frameLive = () => {
      // LIVIANO para señal débil: 240 px y calidad 0,5 (~10-14 KB; antes 320 px / 0,62, ~20-25 KB).
      // Medido con YuNet: detecta igual y el giro varía menos de ±0,03.
      const v = ui.video, k = Math.min(1, 240 / v.videoWidth), cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(v.videoWidth * k)); cv.height = Math.max(1, Math.round(v.videoHeight * k));
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      return cv.toDataURL("image/jpeg", 0.5).split(",")[1];
    };
    const pintarProgresoGiro = d => {
      const o = ui.$("bioi-ovalo");
      if (!d || d.movimiento !== true) {
        o.style.stroke = "#0f172a"; o.style.strokeWidth = "5"; o.style.filter = "";
        return;
      }
      if (d.contrario) {
        o.style.stroke = "#dc2626"; o.style.strokeWidth = "6"; o.style.filter = "drop-shadow(0 0 7px #dc2626)";
        return;
      }
      // 0 = amarillo intenso; 1 = verde. El tono cambia continuamente según el giro real.
      const p = Math.max(0, Math.min(1, Number(d.progreso) || 0));
      const hue = 48 + (142 - 48) * p;
      const color = `hsl(${hue} 88% 45%)`;
      o.style.stroke = color;
      o.style.strokeWidth = String(5 + 2 * p);
      o.style.filter = `drop-shadow(0 0 ${4 + 7 * p}px ${color})`;
    };

    // Indicación EN VIVO según lo que ve el servidor en ese momento (rostro, distancia, lado, avance).
    const pistaVivo = d => {
      if (!d.caras) return "No vemos tu rostro: acércate y busca luz de frente";
      if (d.caras > 1) return "Que nadie se acerque detrás tuyo: solo tu rostro";
      if (d.lejos) return "Acerca más el teléfono a tu cara";
      if (d.listo) return "¡Así! Quédate girado…";
      if (d.contrario) return "Hacia el OTRO lado: hacia la flecha roja";
      if (d.movimiento && d.progreso >= 0.5) return "¡Casi! Gira un poco más y quédate así";
      return "Gira la cabeza hacia la flecha roja (como mirando tu hombro)";
    };
    // Foto de calidad (la que se envía para verificar) del cuadro ACTUAL del video. Sin espejo.
    // 400 px y calidad 0,72 (~25-40 KB; antes 480 px / 0,85, ~45-80 KB). Medido con SFace: el parecido con
    // la imagen original queda en 0,98-0,99, muy lejos de los umbrales de decisión (0,30 / 0,45).
    const frameCaptura = () => {
      const v = ui.video, k = Math.min(1, 400 / v.videoWidth), cv = document.createElement("canvas");
      cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      return cv.toDataURL("image/jpeg", 0.72).split(",")[1];
    };
    // Guía del giro. SEÑAL DÉBIL: antes se mandaba un cuadro, se esperaba la respuesta (2-3 s con mala señal),
    // se pedían DOS respuestas seguidas y recién ahí se sacaba OTRA foto: había que quedarse girado mucho rato.
    // Ahora, junto con cada cuadro que se consulta, se guarda en el teléfono la foto de calidad de ESE mismo
    // instante; se envían varios cuadros sin esperar cada respuesta, y con UNA respuesta "girado" (aunque
    // llegue tarde) se usa la foto de ese instante, aunque la persona ya haya vuelto la cabeza.
    // Devuelve { estado: true | false | null, img }: true = giro logrado (img = foto de ese instante);
    // false = hubo respuestas pero no alcanzó (img = el cuadro más girado, si avanzó lo bastante);
    // null = guía en vivo no disponible (se usa la espera simple).
    function esperarGiroVerde(paso) {
      const direccion = paso === "giro_izquierda" ? "izquierda" : "derecha";
      // Tiempo para lograr el giro (más en el 2.º intento o más). El servidor admite 40 consultas/min por RUT.
      const limite = Date.now() + (reintento ? 12000 : 9000), MAX_CONSULTAS = reintento ? 18 : 14;
      const EN_VUELO = 6, CADA_MS = 450, ESPERA_EXTRA_MS = 3000;
      let consultas = 0, enVuelo = 0, huboRespuesta = false, fallidas = 0, cortar = false, ultimoSeq = 0, mejor = null, fin = false;
      return new Promise(resolve => {
        const terminar = v => { if (fin) return; fin = true; clearInterval(tic); resolve(v); };
        const cerrarSiCorresponde = () => {
          const agotado = cortar || Date.now() >= limite || consultas >= MAX_CONSULTAS;
          if (!huboRespuesta && fallidas >= 3 && enVuelo === 0) return terminar({ estado: null });
          // Se espera a las respuestas pendientes (un poco más allá del límite): pueden traer el "girado".
          if (agotado && (enVuelo === 0 || Date.now() >= limite + ESPERA_EXTRA_MS))
            terminar(huboRespuesta ? { estado: false, img: mejor && mejor.progreso >= 0.8 ? mejor.img : null } : { estado: null });
        };
        const enviar = async () => {
          if (fin) return;
          if (cortar || enVuelo >= EN_VUELO || consultas >= MAX_CONSULTAS || Date.now() >= limite) return cerrarSiCorresponde();
          const seq = ++consultas; enVuelo++;
          const img = frameCaptura(), live = frameLive();   // mismo instante
          let r;
          try { r = await api({ accion: "pose_live", rut, direccion, imagen: live }, 6000); } catch (_) { r = null; }
          enVuelo--;
          ultimaRespuesta = Date.now();
          if (fin) return;
          if (!r || r.status >= 500) {
            fallidas++;
            if (seq > ultimoSeq) msg("Señal débil… sigue girando hacia la flecha");
            return cerrarSiCorresponde();
          }
          if (r.status !== 200) { cortar = true; return cerrarSiCorresponde(); }   // límite de consultas u otro rechazo
          huboRespuesta = true;
          const d = r.d || {};
          if (d.listo) return terminar({ estado: true, img });
          if (d.caras === 1 && !d.contrario && (!mejor || (d.progreso || 0) > mejor.progreso)) mejor = { progreso: d.progreso || 0, img };
          // Solo se pinta la respuesta más reciente (pueden llegar desordenadas).
          if (seq > ultimoSeq) { ultimoSeq = seq; pintarProgresoGiro(d); msg(pistaVivo(d)); }
          cerrarSiCorresponde();
        };
        // Respuestas lentas (señal débil): se avisa que el giro se está enviando, sin cortar la guía.
        let ultimaRespuesta = Date.now();
        const tic = setInterval(() => {
          if (!fin && enVuelo > 0 && Date.now() - ultimaRespuesta > 2000) msg("📶 Señal muy débil, pero tu giro se está enviando… gira hacia la flecha y espera");
          enviar();
        }, CADA_MS);
        enviar();
      });
    }

    try {
      // 1) Consentimiento de UN TOQUE: texto breve y un solo botón "Acepto y continúo". Pulsarlo es la
      //    aceptación expresa (sin casilla ni avisos). Si no la pulsa, no sigue y no se registra el ingreso.
      const t0 = textos(false);
      ui.capa.classList.add("cons");
      ui.$("bioi-cons").innerHTML = `<div class="cab">🔒 <span id="bioi-ctit">${t0.tit}</span></div><div class="cue">
        <p>Tu foto de ingreso se usará para verificar tu identidad (verificación facial), solo en los ingresos a eventos.</p>
        <small>Ley N° 19.628 y Ley N° 21.719. Puedes pedir su eliminación al administrador.</small></div>`;
      ui.$("bioi-no").style.display = "none";
      pDesafio.then(x => { if (x.status === 200 && x.d.modo === "enrolamiento") { ui.$("bioi-ctit").textContent = textos(true).tit; } });
      await elegir(ui, "Acepto y continúo", "");
      ui.$("bioi-no").style.display = "";
      // ¿Aplica? (403/503 = no participa o servicio no configurado -> foto normal).
      if (!r) { msg("Preparando…"); await pDesafio; }
      if (r.status !== 200 || !r.d.pasos) { cerrar(); return null; }
      // 2) Cámara.
      ui.capa.classList.remove("cons");   // cámara: el recuadro del óvalo es BLANCO (ilumina el rostro)
      ui.$("bioi-cons").style.display = "none"; ui.$("bioi-esc").style.display = "block";
      ui.$("bioi-no").textContent = "Cancelar"; msg("Abriendo cámara…");
      // Algunos navegadores (p. ej. el de WhatsApp/Instagram al abrir el link) nunca responden al pedido de
      // cámara: si en 8 s no hay respuesta se sigue con la foto normal en vez de quedar en blanco.
      try {
        let vencido = false;
        const pedido = navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
        pedido.then(s2 => { if (vencido) try { s2.getTracks().forEach(t => t.stop()); } catch (_) { } }, () => { });
        stream = await Promise.race([pedido, esperar(8000).then(() => { vencido = true; throw new Error("sin respuesta de la cámara"); })]);
      } catch (_) { cerrar(); return { sinCamara: true }; }   // sin cámara, sin permiso o sin respuesta: NO ingresa sin enrolarse
      ui.video.srcObject = stream;
      // Se pide reproducir explícitamente (no basta "autoplay": algunos celulares lo bloquean y la imagen
      // queda en blanco). Si en 4 s no hay imagen, se pide un toque ("Activar cámara"), que el navegador
      // siempre permite. Si aun así no hay imagen, se sigue con la foto normal (nunca se queda trabado).
      const hayImagen = () => ui.video.readyState >= 2 && ui.video.videoWidth > 0;
      const esperarImagen = ms => new Promise(res => {
        if (hayImagen()) return res(true);
        const fin = setTimeout(() => res(hayImagen()), ms);
        const ok = () => { if (hayImagen()) { clearTimeout(fin); res(true); } };
        ui.video.onloadeddata = ok; ui.video.onplaying = ok; ui.video.onloadedmetadata = ok;
      });
      const reproducir = () => { try { const pr = ui.video.play(); if (pr && pr.catch) pr.catch(() => { }); } catch (_) { } };   // sin esperar: play() puede quedar pendiente
      reproducir();
      if (!(await esperarImagen(4000))) {
        msg("Toca «Activar cámara» para ver tu imagen.");
        if (!(await elegir(ui, "Activar cámara", "Cancelar"))) { cerrar(); return { cancelado: true }; }
        reproducir();
        if (!(await esperarImagen(5000))) { cerrar(); return { sinCamara: true }; }   // cámara sin imagen: NO ingresa sin enrolarse
      }
      ui.$("bioi-ins").textContent = "Pon tu rostro dentro del óvalo";
      msgHtml((reintento ? "<b>Esta vez sigue estos 3 pasos con calma:</b><br>" : "")
        + "<b>1.</b> Rostro cerca, dentro del óvalo y con luz de frente.<br>"
        + "<b>2.</b> Mira la cámara quieto (cuenta 2, 1).<br>"
        + "<b>3.</b> Gira la cabeza hacia la <b style=\"color:#dc2626\">flecha roja</b> y <b>quédate girado</b> hasta que el óvalo se ponga <b style=\"color:#16a34a\">verde</b>.");
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
      const imgs = []; let fotoBlob = null, imgGiro = null;
      for (let i = 0; i < pasos.length; i++) {
        ui.$("bioi-ins").textContent = INSTR[pasos[i]] || pasos[i]; indicar(pasos[i]);
        if (pasos[i].startsWith("giro_")) {
          msg("Gira la cabeza hacia la flecha roja (como mirando tu hombro)"); ui.$("bioi-cta").textContent = "";
          const giro = await esperarGiroVerde(pasos[i]), verde = giro.estado;
          imgGiro = giro.img || null;   // foto del instante en que se confirmó (o del cuadro más girado)
          if (verde === false && !imgGiro) {
            // Hubo medición, pero aún no alcanzó el giro correcto: damos una oportunidad extra antes de capturar.
            msg("Gira un poco más hacia la flecha y mantén la posición");
            await esperar(reintento ? 1200 : 900);
          } else if (verde === null) {
            // Si la guía en vivo no está disponible, no bloqueamos el ingreso: fallback al comportamiento anterior.
            await esperar((reintento ? 1800 : 1000) + Math.floor(Math.random() * 1000));
          }
        } else {
          msg("Mira la cámara y quédate quieto");
          for (let s = 2; s > 0; s--) { ui.$("bioi-cta").textContent = s; await esperar(900); }
        }
        const v = ui.video;
        imgs.push(imgGiro || frameCaptura());   // giro: la foto del instante confirmado; si no, el cuadro actual
        imgGiro = null;
        if (pasos[i].startsWith("giro_")) {
          // Confirmación visual DESPUÉS de capturar (antes se mostraba primero y la persona volvía al frente).
          ui.$("bioi-esc").classList.add("ok-giro");
          ui.$("bioi-ins").textContent = "✓ Giro correcto";
          ui.$("bioi-fl").querySelector("span").textContent = "¡Bien!";
          ui.$("bioi-cta").textContent = "✓ BIEN";
          try { navigator.vibrate && navigator.vibrate(120); } catch (_) { }
        }
        // La captura de FRENTE es también la foto de ingreso (mismo proceso que la foto normal: WebP 3:4).
        if (pasos[i] === "frente" && !fotoBlob) { try { fotoBlob = await fotoDesde(v); } catch (_) { fotoBlob = null; } }
        ui.$("bioi-cta").textContent = ""; ui.$("bioi-fid").className = "ok"; await esperar(350);
      }
      cerrar();
      if (!fotoBlob) return null;   // no se pudo generar la foto: se usa la foto normal
      return { fotoBlob, token, imagenes: token ? imgs : null, modo: r.status === 200 ? r.d.modo : null };
    } catch (e) {
      cerrar();
      return null;
    }
  }

  // SEÑAL DÉBIL: reintenta el envío hasta que llegue (máx. `veces`, con esperas crecientes). Solo se reintenta
  // cuando NO hubo respuesta (sin red, tiempo agotado) o el servidor falló (5xx); una respuesta 4xx es definitiva.
  async function enviarConReintentos(cuerpo, timeoutMs, veces, onReintento, keepalive) {
    let ultimo = { status: 0, d: {} };
    for (let i = 0; i < veces; i++) {
      if (i) { if (onReintento) try { onReintento(i); } catch (_) { } await esperar(Math.min(8000, 2000 * i)); }
      try { ultimo = await api(cuerpo, timeoutMs, keepalive); } catch (_) { ultimo = { status: 0, d: {} }; continue; }
      if (ultimo.status && ultimo.status < 500) return ultimo;
    }
    return ultimo;
  }

  // Envía las capturas a la función (enrola o verifica). Nunca lanza error: el ingreso ya está guardado.
  async function procesar({ rut, asistenciaId, token, imagenes }) {
    if (!token || !imagenes || !asistenciaId) return "omitido";
    const r = await enviarConReintentos({ accion: "procesar_auto", rut, asistencia_id: asistenciaId, token, imagenes, consentimiento: true }, 30000, 6);
    if (r.status === 409) return "ok";   // un envío anterior sí llegó (el desafío ya se usó)
    return r.status === 200 ? (r.d.resultado || "ok") : "error";
  }

  // Revisión ANTES de registrar. Devuelve { estado }: "bloqueado" (otra persona: no registrar),
  // "repetir" (prueba de vida no superada: repetir, con una pista), "ok" (registrar) o "error"
  // (sin señal / falla: se registra igual, como antes). En el primer ingreso solo revisa la prueba de vida.
  // Con señal débil se reintenta solo (hasta 5 envíos); onReintento(n) permite avisar en pantalla.
  async function verificarPrevio({ rut, token, imagenes, onReintento }) {
    if (!token || !imagenes) return { estado: "error" };
    const r = await enviarConReintentos({ accion: "procesar_auto", previo: true, rut, token, imagenes, consentimiento: true }, 30000, 5, onReintento);
    if (r.status !== 200) return { estado: "error" };
    if (r.d.reintentar) return { estado: "repetir", pista: r.d.pista || "", causa: r.d.causa || "" };
    return { estado: r.d.bloqueado ? "bloqueado" : "ok" };
  }
  // Asocia la verificación previa a la asistencia recién creada (para las palomas del panel).
  async function vincular({ rut, token, asistenciaId, enSegundoPlano }) {
    if (!token || !asistenciaId) return "omitido";
    const r = await enviarConReintentos({ accion: "vincular", rut, token, asistencia_id: asistenciaId }, 15000, 6, null, !!enSegundoPlano);
    return r.status === 200 && r.d.vinculado ? "ok" : "error";
  }

  window.BioIngreso = { capturar, procesar, verificarPrevio, vincular, precalentar };
})();
