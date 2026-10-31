# Piloto biométrico 1:1 (Etapa 1)

Piloto **aislado**: página propia (`biometria-piloto.html`) + función `netlify/functions/biometria`.
No toca `index.html`, el registro de ingreso, `asistencias`, R2 ni las fotos de ingreso.

## Puesta en marcha (solo vista previa)
1. **Supabase → SQL Editor**: ejecutar `supabase-biometria.sql` (crea 2 tablas cerradas; no cambia nada existente).
2. **Netlify → Site configuration → Environment variables**, con alcance **solo "Deploy Previews"**
   (así producción nunca las tiene y la función responde 503 allí):
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → service_role. Marcar como *secret*.
   - `BIOMETRIA_KEY` — 32 bytes aleatorios en base64 (por ejemplo `openssl rand -base64 32`). Marcar como *secret*.
     **Si se pierde o cambia, las plantillas existentes ya no se pueden usar** (hay que volver a enrolar).
   - `BIOMETRIA_PILOTO_RUTS` — tu RUT (p. ej. `12345678-5`). Solo esos RUT pueden usar el piloto.
3. Volver a publicar la vista previa y abrir `/biometria-piloto.html` en el celular.

## Uso
- **Enrolar** (requiere PIN de admin + consentimiento): frente → 2 giros (uno a cada lado, orden aleatorio) → frente.
- **Verificar** (requiere PIN): frente → 2 giros (uno a cada lado, orden aleatorio; la foto de cada giro se toma en un momento aleatorio). Resultado: VERIFICADO / REVISIÓN MANUAL / NO COINCIDE + score.
- **Ver estado**: últimos 20 intentos (sin plantilla). **Borrar plantilla**: elimina la del RUT.

## Biometría en el ingreso (APAGADA por defecto)
Interruptor en Supabase, tabla `config`, clave `biometria_piloto`:
- `''` (vacío) o sin fila = **apagado**: el ingreso es exactamente el de siempre.
- `todos` = todos los guardias. · Una lista de RUT (`13637254-8,11111111-1`) = solo esos.
```sql
insert into config (clave, valor) values ('biometria_piloto', 'todos') on conflict (clave) do update set valor = excluded.valor;  -- encender
update config set valor = '' where clave = 'biometria_piloto';                                                                    -- apagar
```
**Botón por evento**: dentro de "🔳 QR y estado del evento", junto a "Foto de ingreso", el botón
**🧬 Biometría** la activa/desactiva **solo en ese evento** (columna `eventos.biometria`; `false` = solo foto).
Los demás eventos no cambian y no se borran plantillas. Aparece si la foto y el interruptor general están activos.
Requiere una vez en Supabase: `alter table eventos add column if not exists biometria boolean default true;`
El botón **📸 Foto de ingreso** también es **por evento** (columna `eventos.foto_ingreso`; vacío = sigue el valor
general `config.foto_ingreso`). Requiere: `alter table eventos add column if not exists foto_ingreso boolean;`

Para usar `todos`, en Netlify `BIOMETRIA_PILOTO_RUTS` debe ser `*` (el interruptor de la app decide a quién aplica).

Con el interruptor encendido, en lugar de "Foto de verificación" el guardia ve:
1. **Consentimiento**: una casilla "Acepto la verificación facial" + Continuar. Sin marcarla aparece "Debes aceptar"
   (hasta 3 veces); a la **4.ª vez** ingresa **solo con la foto normal** (a R2, sin biometría).
2. Cámara: **frente** (cuenta regresiva) + **1 giro** (flecha, momento de captura aleatorio).
3. La captura de **frente es la foto de ingreso**: se registra la asistencia y la foto se sube a **R2 como siempre**.
4. **Primer ingreso del RUT** = enrolamiento automático (después de registrar, como antes).
   **RUT ya enrolado** = verificación 1:1 **ANTES de registrar** (`procesar_auto` con `previo: true`):
   - si el rostro **NO COINCIDE** (similitud < 0,30: otra persona) → **aviso rojo "Ingreso NO registrado"**,
     no se crea la asistencia ni se sube la foto (puede reintentar; tras 3 rechazos se le indica ir al supervisor);
   - si coincide (o queda en revisión ⚠) → se registra y la verificación se asocia a la asistencia (`vincular`);
   - si la función falla o no hay señal → se registra igual, como antes.
   - **prueba de vida no superada** (no giró, giró al lado contrario, rostro lejos, dos personas…) → aviso
     "🔄 Repite la verificación" con una pista; **no se registra** hasta superarla. Al **6.º fallo seguido** ya no
     se le pide repetir: se registra con la foto y el intento queda vinculado al ingreso (⚠ / "no se pudo enrolar")
     para revisión del admin. Vale también para el
     **primer ingreso**: antes de registrar se revisa la prueba de vida (sin guardar nada) y, tras registrar,
     se enrola con las mismas capturas. Si el rostro es claramente de otra persona, manda el bloqueo ⛔.
   Los rechazos quedan en `biometria_intentos` sin asistencia. Un guardia rechazado por error: el admin puede
   desactivar la biometría del evento (botón 🧬) o restablecer su plantilla.
   Nota: el bloqueo lo aplica la app; quien manipule el navegador podría saltárselo (las tablas de asistencia
   siguen abiertas a la anon key, como siempre).
5. Panel admin, junto a la foto: **✔✔ azul** verificado · **✔ azul** enrolado (primer ingreso) · **⚠** revisión ·
   **✖** no coincide. Clic = detalle y **Restablecer plantilla** (se vuelve a enrolar en el próximo ingreso).
   Resultado ORIENTATIVO. Detalle con score y "Restablecer" solo admin.
   **Vista empresa**: ve las mismas señales (✔✔ ✔ ⚠ ✖) junto a la foto, **solo el estado** (sin score, RUT ni
   detalle), vía `accion: "resultados_empresa"` con el slug del evento: la función responde únicamente ingresos de
   ese evento y nada si el evento tiene la biometría desactivada.
- Sin cámara o sin permiso, se usa la foto normal de siempre.
- La vista previa usa la MISMA base de datos que producción: para probar, usa un evento de prueba y el QR
  generado desde el panel de la vista previa.

## Ver los enrolados
Panel admin → "🔳 QR y estado del evento" → **🧬 Enrolados** (con PIN). Muestra cuántos guardias están enrolados,
nuevos, verificados, "no coincide" y pruebas de vida fallidas de los últimos 7 días, y la lista (RUT, nombre, fecha)
con buscador y **Restablecer**. Consulta la función (`accion: "resumen"`) solo al abrir la ventana.

## Qué se guarda
- `guardias_biometria`: plantilla **cifrada** (AES-256-GCM, ligada al RUT), modelo, versión, fecha, consentimiento.
- `biometria_intentos`: tipo, estado, score, resultado de la prueba de vida, medidas y tiempos. **Sin imágenes.**

### Borrado automático (12 h después de terminado el evento)
La función programada `netlify/functions/borrar-fotos.mjs` (cada hora, con `SUPABASE_SERVICE_ROLE_KEY`) borra la
plantilla y los intentos de cada RUT que ya no tiene ingresos en ningún evento vigente (evento sin terminar o
terminado hace menos de 12 h). El guardia se vuelve a enrolar solo en su primer ingreso del siguiente evento.
Los eventos **sin fecha** nunca terminan, así que sus guardias conservan la plantilla: pon siempre la fecha.

### Limpieza de respaldo (60 días)
Al abrir el panel admin (como máximo cada 6 h, junto con la purga de fotos) se llama a la función con
`accion: "purgar"` y el PIN de admin. La función borra:
- los `biometria_intentos` con más de 60 días;
- las plantillas de `guardias_biometria` enroladas hace más de 60 días **sin ningún intento en los últimos 60 días**
  (guardias que dejaron de venir). Esos guardias se vuelven a enrolar solos en su próximo ingreso.
Los guardias activos conservan su plantilla. Si no hay PIN en la pestaña o falla, se reintenta la próxima vez.

## Límites conocidos (no es antifraude)
**El resultado es ORIENTATIVO** (apoyo al supervisor). La prueba de vida (2 giros en orden aleatorio, captura en momento
aleatorio, consistencia entre frames) frena una **foto fija** y dificulta un video; en el piloto un video logró pasar
1 de 4 intentos con un solo giro. **No** frena de forma confiable un video
de la persona, cámaras virtuales, máscaras ni un navegador modificado. Para eso se requiere un proveedor
certificado (Etapa 3).

## Reversión total
1. Cerrar el PR del piloto y borrar la rama `claude/biometria-piloto` (si no se fusionó, producción nunca cambió).
2. Supabase: ejecutar `supabase-biometria-borrar.sql`.
3. Netlify: borrar `SUPABASE_SERVICE_ROLE_KEY`, `BIOMETRIA_KEY`, `BIOMETRIA_PILOTO_RUTS` (y opcionalmente rotar la service_role key en Supabase).
4. Punto de restauración de producción: rama `respaldo/pre-biometria-piloto` (`d27e26b`).

## Señal débil y motivos de fallo
- Con señal débil los envíos se **reintentan solos** hasta que llegan: verificación (hasta 5 envíos, con aviso
  "📶 Señal débil" en pantalla), registro del ingreso (hasta 4, revisando antes si el anterior sí llegó),
  foto (4 seguidos y luego queda en el teléfono y se reenvía cada minuto), enrolamiento y vínculo (hasta 6).
  El servidor acepta un envío reintentado hasta 2 min después de vencido el desafío (el nonce sigue siendo de un uso).
- Si no supera la prueba de vida, el guardia ve el **Motivo** (p. ej. "No giró lo suficiente").
- Panel 🧬 Enrolados: franja con las causas de los últimos 7 días y, por guardia, clic en el número de
  "Vida fallida" para ver sus motivos.
