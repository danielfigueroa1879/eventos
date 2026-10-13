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
- **Enrolar** (requiere PIN de admin + consentimiento): frente → giro indicado → frente.
- **Verificar** (requiere PIN): frente → giro indicado. Resultado: VERIFICADO / REVISIÓN MANUAL / NO COINCIDE + score.
- **Ver estado**: últimos 20 intentos (sin plantilla). **Borrar plantilla**: elimina la del RUT.

## Qué se guarda
- `guardias_biometria`: plantilla **cifrada** (AES-256-GCM, ligada al RUT), modelo, versión, fecha, consentimiento.
- `biometria_intentos`: tipo, estado, score, resultado de la prueba de vida, medidas y tiempos. **Sin imágenes.**

## Límites conocidos (no es antifraude)
La prueba de vida (giro aleatorio + consistencia entre frames) frena una **foto fija**. **No** frena un video
de la persona, cámaras virtuales, máscaras ni un navegador modificado. Para eso se requiere un proveedor
certificado (Etapa 3).

## Reversión total
1. Cerrar el PR del piloto y borrar la rama `claude/biometria-piloto` (si no se fusionó, producción nunca cambió).
2. Supabase: ejecutar `supabase-biometria-borrar.sql`.
3. Netlify: borrar `SUPABASE_SERVICE_ROLE_KEY`, `BIOMETRIA_KEY`, `BIOMETRIA_PILOTO_RUTS` (y opcionalmente rotar la service_role key en Supabase).
4. Punto de restauración de producción: rama `respaldo/pre-biometria-piloto` (`d27e26b`).
