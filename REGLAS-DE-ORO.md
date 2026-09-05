# PROMPT — Reglas de oro de base de datos (aplicar desde el inicio del proyecto)

Vas a construir una app web con backend en base de datos (Supabase/Postgres u
otra equivalente). Antes de escribir cualquier funcionalidad, deja establecidas
y respeta durante TODO el proyecto las siguientes **REGLAS DE ORO**. Son
obligatorias e innegociables: la integridad de los datos está por encima de la
comodidad de la interfaz.

## 1. Nunca un falso "éxito"
- Una acción SOLO se declara exitosa (mostrar "guardado", "ingreso registrado",
  entregar ticket/comprobante) DESPUÉS de que el servidor CONFIRMÓ la escritura.
- La operación de guardado debe devolver un valor de confirmación real
  (`true`/la fila insertada). Si el servidor devuelve error, se lanza excepción;
  si no confirma, se trata como FALLO.
- Al insertar, pide de vuelta la fila creada (p. ej. `.insert(...).select().single()`)
  y verifica que exista su `id` antes de mostrar éxito.

## 2. Sin conexión = no se registra (y se avisa claro)
- Si `navigator.onLine === false`, no intentes la escritura: avisa
  "Sin conexión. Verifica tu señal e intenta nuevamente." El usuario
  simplemente no podrá completar la acción hasta tener señal. Eso es correcto.

## 3. Timeout en toda escritura
- Envuelve cada operación de red en un límite de tiempo (p. ej. 20 s) con
  `Promise.race`. Con mala señal la petición puede "colgarse" sin dar error:
  si no confirma a tiempo, trátala como FALLO (no como éxito) y permite reintentar.

## 4. Feedback mientras se guarda
- Deshabilita el botón y muestra "Guardando… no cierres esta ventana" mientras
  se confirma. Oculta cualquier comprobante/éxito hasta la confirmación real.

## 5. Anti-duplicado a nivel de base de datos
- Define restricciones `UNIQUE` para lo que no puede repetirse
  (p. ej. `unique(evento_id, rut)`, `unique(slug)`). La unicidad se garantiza
  en la BD, no solo en el código.
- Para numeración/secuencias sin choques, úsalas del lado del servidor
  (secuencia/RPC atómica en Postgres), nunca calculadas en el cliente.

## 6. Idempotencia y reintentos con mala señal
- Contempla el caso "la escritura SÍ llegó pero se perdió la respuesta":
  ante un error, RE-CONSULTA al servidor si el registro ya existe; si existe,
  muestra el éxito correcto en lugar de un error confuso o de duplicar.
- Si el error es de duplicado (código `23505` / "unique"/"duplicate"), interprétalo
  como "ya estaba registrado" y resuélvelo de forma amable, no como error grave.
- Antes de crear, comprueba (local y en servidor) si ya existe para no duplicar.

## 7. Sin falsos positivos por normalización
- Al detectar "cambió un dato", normaliza AMBOS lados igual (mayúsculas, espacios)
  antes de comparar, para no marcar como "modificado" algo que no cambió.

## 8. Estados de revisión / aprobación explícitos
- Los datos que ingresa/edita un usuario final quedan en estado "pendiente"
  (`aprobado = false`) hasta que un administrador los apruebe. Distingue el tipo
  ("nuevo" vs "editado") y muéstralo claramente. El admin puede editar siempre;
  el usuario final, de forma limitada (p. ej. una sola vez).

## 9. Errores visibles y honestos
- Nunca ocultes un fallo de escritura. Si algo no se guardó, dilo con un mensaje
  claro y accionable ("verifica tu conexión e intenta nuevamente") y reactiva el botón.
- Registra en consola el error real para diagnóstico.

## 10. Fuente de verdad y sincronización
- La base de datos es la fuente de verdad; el estado local es solo caché.
- Al fusionar cambios de varios dispositivos, gana el más reciente (`updated_at`)
  y propaga los borrados (tombstones) para que no "revivan".
- Usa realtime/subscripciones para reflejar cambios, pero valida siempre contra
  el servidor antes de confirmar una acción crítica.

## Entregable inicial
Antes de la primera funcionalidad, crea:
1. El esquema SQL con claves primarias, `UNIQUE` y `foreign keys` correctos,
   más índices y `updated_at`.
2. Una capa de acceso a datos con un envoltorio `ok(resp)` que lance ante error,
   un helper `conTimeout(promise, ms)` y una detección `esErrorDuplicado(err)`.
3. Un flujo de escritura de ejemplo que implemente las reglas 1–6 de punta a punta.

Confírmame que aplicarás estas reglas de oro y muéstrame primero el esquema SQL
y la capa de datos antes de avanzar con la interfaz.

---

## 11. Contraseñas y secretos: NUNCA en el código del cliente
- Cualquier constante escrita en el HTML/JS del navegador (un PIN, una clave)
  es **visible para cualquiera** con "Ver código fuente" o las herramientas de
  desarrollador. Ofuscar (base64, minificar) NO es seguridad: solo entretiene.
- La verificación de contraseñas debe hacerse **en el servidor**. La clave real
  vive en la base de datos; el cliente solo envía lo que el usuario escribió y el
  servidor responde verdadero/falso. Ejemplo con Supabase/Postgres (RPC):
  ```sql
  -- La clave se guarda hasheada en una tabla que el cliente NO puede leer.
  create or replace function verificar_clave(p_clave text)
  returns boolean language sql security definer as $$
    select exists(
      select 1 from secretos
      where nombre = 'eliminar'
        and hash = crypt(p_clave, hash)   -- pgcrypto
    );
  $$;
  ```
  En el cliente: `const ok = await sb.rpc('verificar_clave', { p_clave: valor });`
  Así el HTML nunca contiene la contraseña.
- **Nunca subas secretos reales a un repositorio público** (GitHub). Usa variables
  de entorno / configuración del hosting, y un archivo `.gitignore` para las claves.
- La `ANON KEY` de Supabase SÍ puede ir en el cliente (es pública), pero SOLO si
  proteges las tablas con **Row Level Security (RLS)** bien configurado. Políticas
  abiertas (`using (true) with check (true)`) dejan la base al descubierto para
  cualquiera que tenga esa key: restringe lecturas/escrituras por rol o por RPC.
- Contraseñas cortas (PIN de 4 dígitos) son fáciles de adivinar por fuerza bruta;
  aun verificadas en el servidor, usa claves largas y/o límites de intentos.

---

## CASO REAL — "El guardia fantasma de 300 minutos" (lección aprendida)

**Qué pasó:** En un proyecto anterior, de repente un guardia aparecía "En Examen"
con 300 minutos en el cronómetro, aunque ya había terminado. Reaparecía como
fantasma en un PC y descuadraba a todos los administradores.

**Causa raíz (dos errores combinados):**
1. Cada dispositivo guardaba **TODO el estado en un solo bloque JSON** y, al
   guardar o al reconectar, **empujaba el bloque entero** al servidor.
2. El cronómetro se calculaba desde un `examStartTime` **guardado en el registro
   y sincronizado** dentro de ese bloque.

**La secuencia:** un guardia terminaba (servidor correcto) → pero un celular que
había estado **sin señal** conservaba una copia vieja donde ese guardia seguía
"En Examen" con un `examStartTime` de horas atrás → al reconectar, ese celular
**re-empujaba su bloque viejo** y revivía al guardia → el cronómetro mostraba
`ahora − (hace 5 h)` ≈ **300 minutos**.

**Por qué NO puede pasar con el modelo correcto (una fila por registro):**
- El dispositivo nunca manda "toda la lista", solo la operación puntual sobre una
  fila. Una copia vieja no tiene forma de resucitar nada.
- El servidor es la fuente de verdad; se lee fresco.
- Los borrados son DELETE de fila (definitivos).
- El tiempo se calcula al mostrar, desde un timestamp fijo del servidor, no desde
  un contador sincronizado y revivible.

**Regla de una línea:** *el bug nació de "cada dispositivo guarda y empuja todo el
estado"; la cura es "cada acción toca solo su fila y el servidor manda".*
