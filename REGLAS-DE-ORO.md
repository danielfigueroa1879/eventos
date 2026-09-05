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
