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

## 🎨 Personalizar
- **Colores:** en `index.html`, variable CSS `--brand` (verde institucional).
- **Reglas legales:** las constantes `MESES_VIGENCIA`, `ENTRADA_VIGENCIA_LEY` y `FECHA_TOPE_PRORROGA` ya están correctas (Ley 21.659 / prórroga Ley 21.825 hasta 28-may-2027). No las cambies salvo instrucción de OS10.

## 🔒 Nota de seguridad (importante)
El PIN del panel es una barrera básica del lado del navegador. La `anon key` de Supabase permite leer y escribir en las tablas a quien tenga el enlace del sistema. Para un evento de fiscalización esto es un riesgo aceptable, pero **no publiques el enlace del panel** (comparte solo los QR de cada evento, que llevan al formulario). Si más adelante quieres control de acceso real (login de administradores, que el público solo pueda registrarse pero no ver ni borrar), se implementa con **Supabase Auth** + políticas RLS por rol — pídemelo y lo agregamos.

## 📁 Archivos
- `index.html` — la aplicación completa (panel + formulario del guardia).
- `supabase.sql` — estructura de la base de datos.
- `INSTRUCCIONES.md` — este archivo.
