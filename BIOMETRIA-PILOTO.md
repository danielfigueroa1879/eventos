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
**Botón en el panel**: dentro de "🔳 QR y estado del evento", junto a "Foto de ingreso", el botón
**🧬 Biometría** cambia entre `todos` (Activada) y `''` (Desactivada = solo foto). Pide confirmación y no borra
plantillas: al reactivarla los guardias ya enrolados se siguen verificando. Solo aparece si la foto está activada.

Para usar `todos`, en Netlify `BIOMETRIA_PILOTO_RUTS` debe ser `*` (el interruptor de la app decide a quién aplica).

Con el interruptor encendido, en lugar de "Foto de verificación" el guardia ve:
1. **Consentimiento**: una casilla "Acepto la verificación facial" + Continuar. Sin marcarla aparece "Debes aceptar"
   (hasta 3 veces); a la **4.ª vez** ingresa **solo con la foto normal** (a R2, sin biometría).
2. Cámara: **frente** (cuenta regresiva) + **1 giro** (flecha, momento de captura aleatorio).
3. La captura de **frente es la foto de ingreso**: se registra la asistencia y la foto se sube a **R2 como siempre**.
4. Después se envían las capturas a la función: **primer ingreso del RUT = enrolamiento automático**;
   siguientes = **verificación 1:1**. Si la biometría falla o no hay señal, el ingreso y la foto quedan igual.
5. Panel admin, junto a la foto: **✔✔ azul** verificado · **✔ azul** enrolado (primer ingreso) · **⚠** revisión ·
   **✖** no coincide. Clic = detalle y **Restablecer plantilla** (se vuelve a enrolar en el próximo ingreso).
   Solo admin; la vista empresa no lo ve. Resultado ORIENTATIVO.
- Sin cámara o sin permiso, se usa la foto normal de siempre.
- La vista previa usa la MISMA base de datos que producción: para probar, usa un evento de prueba y el QR
  generado desde el panel de la vista previa.

## Qué se guarda
- `guardias_biometria`: plantilla **cifrada** (AES-256-GCM, ligada al RUT), modelo, versión, fecha, consentimiento.
- `biometria_intentos`: tipo, estado, score, resultado de la prueba de vida, medidas y tiempos. **Sin imágenes.**

### Limpieza automática (cada 2 meses / 60 días)
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
