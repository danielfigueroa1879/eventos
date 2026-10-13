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

## Etapa 2: verificación opcional al registrar el ingreso (APAGADA por defecto)
- Interruptor en Supabase (tabla `config`), clave `biometria_piloto` = RUT del piloto separados por coma.
  Encender: `insert into config (clave, valor) values ('biometria_piloto', '13637254-8') on conflict (clave) do update set valor = excluded.valor;`
  Apagar: `update config set valor = '' where clave = 'biometria_piloto';`
- Solo esos RUT ven, **después** de que su ingreso quedó registrado (asistencia + foto normal), la pantalla opcional
  de 2 giros. Pueden **Omitir**. Si falla o no hay señal, el ingreso sigue registrado igual.
- La función solo acepta una asistencia de ese RUT creada hace menos de 15 min, máximo 2 intentos por asistencia.
- Al guardia no se le muestra el score. En el panel admin aparece una insignia "🧬 … · orientativo" en la fila del
  piloto (se consulta a la función con el PIN de admin). La vista empresa no la ve.
- **No se escribe en `asistencias`**: el resultado va a `biometria_intentos` con `asistencia_id`.
- Ojo: la vista previa usa la MISMA base de datos que producción. Para probar, registra el ingreso en un evento de prueba.

## Qué se guarda
- `guardias_biometria`: plantilla **cifrada** (AES-256-GCM, ligada al RUT), modelo, versión, fecha, consentimiento.
- `biometria_intentos`: tipo, estado, score, resultado de la prueba de vida, medidas y tiempos. **Sin imágenes.**

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
