-- =====================================================================
--  CLAVES EN EL SERVIDOR (Supabase)  —  Panel de Control de Guardias
-- =====================================================================
--  Con esto el PIN de administrador y la clave para ELIMINAR eventos
--  dejan de estar en index.html. Las claves reales quedan HASHEADAS en
--  la base de datos y solo se verifican en el servidor: nadie que mire
--  el código fuente de la página podrá verlas.
--
--  CÓMO USARLO:
--   1. Entra a tu proyecto en https://supabase.com  ->  SQL Editor.
--   2. PRIMERO cambia las dos claves de ejemplo del PASO 3 por las tuyas.
--   3. Pega TODO este archivo y pulsa "Run".
--   4. Listo. Para cambiar una clave luego, vuelve a ejecutar SOLO el PASO 3
--      con el nuevo valor (o el PASO 3b para una sola).
-- =====================================================================

-- PASO 1) Extensión para hashear contraseñas (en Supabase va en el esquema "extensions").
create extension if not exists pgcrypto with schema extensions;

-- PASO 2) Tabla de secretos. Con RLS activado y SIN políticas de lectura:
--         nadie (ni con la anon key pública) puede leer los hashes.
create table if not exists public.secretos (
  nombre text primary key,
  hash   text not null
);
alter table public.secretos enable row level security;
revoke all on public.secretos from anon, authenticated;
-- (No creamos políticas a propósito: así la tabla queda inaccesible desde el cliente.)

-- PASO 3) GUARDA TUS CLAVES  ->  CAMBIA los dos textos entre comillas por los tuyos.
--         'admin'    = PIN para entrar al panel.
--         'eliminar' = clave para borrar un evento (dásela solo a quien confíes).
insert into public.secretos (nombre, hash) values
  ('admin',    extensions.crypt('8979',   extensions.gen_salt('bf'))),
  ('eliminar', extensions.crypt('4040', extensions.gen_salt('bf')))
on conflict (nombre) do update set hash = excluded.hash;

-- PASO 3b) (opcional) Para cambiar SOLO una clave más adelante, usa una de estas:
-- update public.secretos set hash = extensions.crypt('NUEVO_PIN_ADMIN',    extensions.gen_salt('bf')) where nombre = 'admin';
-- update public.secretos set hash = extensions.crypt('NUEVA_CLAVE_BORRAR', extensions.gen_salt('bf')) where nombre = 'eliminar';

-- PASO 4) Función que SOLO responde verdadero/falso. La clave nunca sale del servidor.
create or replace function public.verificar_clave(p_nombre text, p_clave text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists(
    select 1 from public.secretos
    where nombre = p_nombre
      and hash = extensions.crypt(p_clave, hash)
  );
$$;

-- PASO 5) Permitir que la página (rol anon) pueda LLAMAR la función (pero NO leer la tabla).
grant execute on function public.verificar_clave(text, text) to anon, authenticated;

-- =====================================================================
--  COMPROBACIÓN (opcional): debe devolver true con tu clave y false con otra.
--    select public.verificar_clave('admin', 'CAMBIA_ESTE_PIN_ADMIN');  -- true
--    select public.verificar_clave('admin', 'loquesea');               -- false
-- =====================================================================
