# Control de Guardias OS10 — Puesta en marcha

Sistema multi-evento de control de guardias para Fiestas Patrias. Un solo archivo (`index.html`) + base de datos Supabase + hosting en Netlify.

---

## ✅ Probarlo YA (modo demo, sin configurar nada)
Abre `index.html` con doble clic. Entra al panel con el PIN **1234**. Trae 2 eventos y 3 guardias de ejemplo. En modo demo los datos se guardan solo en ese dispositivo (sirve para conocer el sistema, no para producción).

---

## 🚀 Pasar a PRODUCCIÓN (Netlify + Supabase)

### PASO 1 — Crear la base de datos en Supabase
1. Entra a https://supabase.com → **Sign in** → **New project** (elige región y una contraseña; el plan gratis basta).
2. Cuando el proyecto esté listo, ve a **SQL Editor** (menú izquierdo) → **New query**.
3. Abre el archivo `supabase.sql`, copia TODO su contenido, pégalo y presiona **Run**. Debe decir *Success*.

### PASO 2 — Copiar tus 2 claves
1. En Supabase ve a **Project Settings** (engranaje) → **API**.
2. Copia:
   - **Project URL** (ej: `https://abcd1234.supabase.co`)
   - **anon public** key (una cadena larga)

### PASO 3 — Pegar las claves en el archivo
1. Abre `index.html` con el Bloc de notas (o cualquier editor).
2. Arriba, en la sección CONFIGURACIÓN, reemplaza:
   ```js
   const SUPABASE_URL = "";        // pega aquí tu Project URL
   const SUPABASE_ANON_KEY = "";   // pega aquí tu anon public key
   const ADMIN_PIN = "1234";       // cámbialo por tu PIN
   ```
3. Guarda el archivo.

### PASO 4 — Publicar en Netlify (gratis)
**Opción rápida (arrastrar):**
1. Entra a https://app.netlify.com/drop
2. Arrastra la carpeta `control-guardias` completa a la ventana.
3. Netlify te da una URL pública (ej: `https://tu-sitio.netlify.app`). ¡Listo!

> Para un nombre propio: en Netlify → *Site settings → Change site name*, o conecta tu dominio.

### PASO 5 — Usarlo
1. Abre tu URL de Netlify → entra con tu PIN.
2. **+ Nuevo evento** → nombre, empresa, cantidad de guardias. Se genera el QR automáticamente.
3. **Descarga/Imprime el QR** y pégalo en la entrada del evento.
4. Los guardias escanean, ingresan su RUT y quedan registrados. Tú los ves llegar en tiempo real, con su vigencia y hora de ingreso.

---

## 📸 Foto de verificación al ingresar (nuevo)
Permite exigir una **foto** a quien registra su ingreso por el QR, para dejar constancia de quién ingresó realmente los datos. La foto se toma con una **guía ovalada** para el rostro (se ve profesional), se convierte a **WebP en HD** (no Full HD) para que pese muy poco, y queda adjunta al registro.

**Activar/desactivar:** en el panel de administrador, abre las acciones ("Desplegar") y usa el interruptor **📸 Foto de ingreso**. Es un ajuste global (aplica a todos los eventos y a todos los dispositivos).

**Ver las fotos (admin):** en el listado aparece un ícono 📷 junto a la hora de ingreso, y en el **Detalle del guardia** se muestra la miniatura; al tocarla se ve ampliada con opción de descargar.

**Requisito de instalación (una sola vez):** vuelve a ejecutar el archivo `supabase.sql` en **Supabase → SQL Editor** (es seguro re-ejecutarlo). Eso agrega la columna `asistencias.foto_url`, la tabla `config` y crea el bucket de Storage **`ingresos`** con sus permisos. Sin este paso, el interruptor no se podrá guardar y las fotos no se subirán.

> Nota: el bucket `ingresos` es **público** (quien tenga la URL exacta de una foto puede verla, pero no listar el bucket). Es el mismo criterio de la nota de seguridad de más abajo.

## 🎨 Personalizar
- **Colores:** en `index.html`, variable CSS `--brand` (verde institucional).
- **Reglas legales:** las constantes `MESES_VIGENCIA`, `ENTRADA_VIGENCIA_LEY` y `FECHA_TOPE_PRORROGA` ya están correctas (Ley 21.659 / prórroga Ley 21.825 hasta 28-may-2027). No las cambies salvo instrucción de OS10.

## 🔒 Nota de seguridad (importante)
El PIN del panel es una barrera básica del lado del navegador. La `anon key` de Supabase permite leer y escribir en las tablas a quien tenga el enlace del sistema. Para un evento de fiscalización esto es un riesgo aceptable, pero **no publiques el enlace del panel** (comparte solo los QR de cada evento, que llevan al formulario). Si más adelante quieres control de acceso real (login de administradores, que el público solo pueda registrarse pero no ver ni borrar), se implementa con **Supabase Auth** + políticas RLS por rol — pídemelo y lo agregamos.

## 📁 Archivos
- `index.html` — la aplicación completa (panel + formulario del guardia).
- `supabase.sql` — estructura de la base de datos.
- `INSTRUCCIONES.md` — este archivo.

## 📷 Fotos en Cloudflare R2 (bucket privado)

Las fotos de ingreso **nuevas** se guardan en Cloudflare R2. Supabase sigue con la base de datos y
solo guarda la referencia de la foto (`r2:<evento_id>/<asistencia_id>.webp`). Las fotos antiguas
(sin `r2:`) se siguen mostrando desde Supabase Storage, sin cambios.

Las claves de R2 **nunca** van en `index.html` ni en GitHub: las usa solo la función de Netlify
`netlify/functions/fotos.mjs`, que entrega enlaces firmados. Las fotos van directo entre el
navegador y R2.

Si R2 aún no está configurado (o falla), la app sube la foto a Supabase como antes: no se rompe nada.

### 1) Variables de entorno en Netlify
Netlify → tu sitio → **Site configuration → Environment variables → Add a variable**:

| Variable | Valor |
|---|---|
| `R2_ACCESS_KEY_ID` | Access Key ID del token de R2 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key del token de R2 |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (el "S3 API endpoint") |
| `R2_BUCKET_NAME` | `guardias` |

Luego **Deploys → Trigger deploy → Deploy site** para que la función tome las variables.

### 2) CORS del bucket en Cloudflare
Cloudflare → R2 → bucket `guardias` → **Settings → CORS Policy → Add/Edit** y pega:

```json
[
  {
    "AllowedOrigins": ["https://os10eventos.netlify.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "cache-control"],
    "MaxAgeSeconds": 86400
  }
]
```

### 3) Comprobar
1. Registra un ingreso de prueba con foto.
2. En Supabase → tabla `asistencias`, la columna `foto_url` de ese registro debe empezar con `r2:`.
3. En Cloudflare → R2 → `guardias` deben aparecer `<asistencia>.webp` y `<asistencia>_t.webp`.
4. En el panel admin la miniatura y la foto ampliada deben verse. Al recargar la página, en
   DevTools → Network la miniatura debe salir "(disk cache)" o "(memory cache)".

Si `foto_url` no empieza con `r2:`, revisa en Netlify → **Logs → Functions → fotos** el error.

Caché: los enlaces de lectura se firman con una fecha fija cada 30 minutos y vencen a la hora, así el
enlace no cambia en cada recarga dentro de esa ventana y el navegador reutiliza la foto ya descargada.

## 🗑️ Borrado automático de fotos (al terminar el evento)

La función programada `netlify/functions/borrar-fotos.mjs` corre sola **cada 15 minutos** y borra de R2
la foto y la miniatura de cada ingreso **al terminar el evento** (hora de Chile):
- Evento con turnos: al terminar el último turno del último día (`fecha_hasta` o `fecha_evento`).
- Evento sin turnos / partido: a las 24:00 del último día.
- Partido cerrado y archivado: al cerrarlo.

Usa las mismas variables de R2 ya configuradas en Netlify. Un evento sin fecha no se toca.
Las fotos antiguas guardadas en Supabase Storage (sin `r2:`) no se borran con esta función.

La misma función borra también los **datos biométricos** (plantilla cifrada e intentos) de los guardias que
ya no tienen ingresos en ningún evento vigente. Para eso necesita la variable `SUPABASE_SERVICE_ROLE_KEY` en
Netlify (la misma que usa la biometría). Pon siempre la fecha del evento: un evento sin fecha nunca "termina".

## 🔑 Ver fotos exige PIN (enlaces de 1 hora)

- La función `fotos` solo entrega enlaces para **ver** o **bajar** fotos si recibe el **PIN de administrador**
  (lo comprueba en Supabase). El panel lo envía solo, con el PIN con que se entró.
- Cada enlace para ver una foto **vence en 1 hora**.
- La vista de **empresa** ya **no muestra fotos** (solo la lista de guardias).
- Subir la foto al registrar el ingreso sigue sin PIN (lo hace el guardia), con enlace de 10 minutos.
