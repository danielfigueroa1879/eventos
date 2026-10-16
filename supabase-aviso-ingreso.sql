-- =====================================================================
--  AVISO POR CORREO: "comenzaron los ingresos" (Supabase)  —  Control de Guardias
-- =====================================================================
--  Ejecuta este archivo UNA VEZ en Supabase -> SQL Editor -> New query -> Run.
--  Se puede volver a ejecutar sin problema (no borra datos).
--
--  ANTES de ejecutarlo, reemplaza en este texto (no lo subas a GitHub con los valores reales):
--    PEGA_AQUI_EL_AVISO_TOKEN  -> el MISMO texto que pusiste en Netlify como AVISO_TOKEN
--    https://os10eventos.netlify.app -> la dirección de tu sitio, si es otra
--
--  Qué hace:
--   Cada vez que se registra un ingreso (INSERT en asistencias), la base de datos avisa a la
--   función de Netlify "aviso-ingreso". La función decide si es el PRIMER ingreso del turno y,
--   solo en ese caso, envía el correo. El aviso es ASÍNCRONO (extensión pg_net): el ingreso del
--   guardia se guarda igual y al instante, aunque la función o el correo fallen.
--
--  Para DESACTIVAR los avisos:   drop trigger if exists trg_aviso_ingreso on public.asistencias;
-- =====================================================================

create extension if not exists pg_net;

create or replace function public.aviso_ingreso()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://os10eventos.netlify.app/.netlify/functions/aviso-ingreso',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-aviso-token', 'PEGA_AQUI_EL_AVISO_TOKEN'),
    body    := jsonb_build_object('record', jsonb_build_object('id', new.id, 'evento_id', new.evento_id, 'hora_ingreso', new.hora_ingreso))
  );
  return new;
exception when others then
  return new;   -- pase lo que pase con el aviso, el ingreso NUNCA se bloquea
end;
$$;

-- Nadie puede ejecutar la función directamente (solo el disparador).
revoke all on function public.aviso_ingreso() from public, anon, authenticated;

drop trigger if exists trg_aviso_ingreso on public.asistencias;
create trigger trg_aviso_ingreso
  after insert on public.asistencias
  for each row execute function public.aviso_ingreso();
