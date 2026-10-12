-- =====================================================================
--  CIERRE DE PARTIDO EN UNA TRANSACCIÓN (Supabase)  —  Control de Guardias
-- =====================================================================
--  Ejecuta este archivo UNA VEZ en Supabase -> SQL Editor -> New query -> Run.
--  Se puede volver a ejecutar sin problema (no borra datos).
--
--  Qué hace:
--   1) Guarda en el historial el id de la asistencia original (asistencia_id), para enlazar
--      una foto que termine de subir después del cierre SIN confundirla con otro registro.
--   2) Registra la hora del SERVIDOR en que se creó cada asistencia (creada), para que la
--      función de fotos solo entregue enlaces de subida a ingresos recién hechos.
--   3) Crea la función cerrar_partido: archiva y borra las asistencias en UNA transacción.
--      O se completan ambas cosas, o no cambia nada (aunque se corte la conexión o se
--      cierre la pestaña). Dos cierres a la vez no duplican: cada asistencia se archiva una vez.
-- =====================================================================

alter table partidos_historial_asist add column if not exists asistencia_id uuid;
alter table partidos_historial_asist add column if not exists puesto text;
alter table partidos_historial_asist add column if not exists foto_url text;
create index if not exists idx_hista_asis on partidos_historial_asist(asistencia_id);

alter table asistencias add column if not exists creada timestamptz default now();

create or replace function public.cerrar_partido(p_evento_id uuid, p_partido text, p_fecha date, p_filas jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_hid uuid;
  v_n   integer;
begin
  insert into partidos_historial (evento_id, partido, fecha, total)
  values (p_evento_id, p_partido, p_fecha, 0)
  returning id into v_hid;

  -- Borra SOLO las asistencias pedidas de ESTE evento y archiva exactamente las que borró,
  -- con su foto real. Todo dentro de la misma transacción.
  with borradas as (
    delete from asistencias a
     where a.evento_id = p_evento_id
       and a.id in (select (f->>'id')::uuid from jsonb_array_elements(p_filas) f)
    returning a.*
  ), ins as (
    insert into partidos_historial_asist
      (historial_id, asistencia_id, rut, nombres, apellidos, telefono, fecha_ultimo_examen, vigencia, hora_ingreso, puesto, foto_url)
    select v_hid, b.id, b.rut, f->>'nombres', f->>'apellidos', f->>'telefono',
           nullif(f->>'fecha_ultimo_examen', '')::date, f->>'vigencia', b.hora_ingreso, nullif(f->>'puesto', ''),
           case when b.foto_url is null then null
                when b.foto_url like 'r2:%' then b.foto_url
                else p_evento_id::text || '/' || b.id::text || '.webp' end
      from borradas b
      join jsonb_array_elements(p_filas) f on (f->>'id')::uuid = b.id
    returning 1
  )
  select count(*) into v_n from ins;

  -- Nada que archivar (otro administrador ya lo cerró): se deshace todo, incluida la cabecera.
  if v_n = 0 then
    raise exception 'ya_archivado' using errcode = 'P0001';
  end if;

  update partidos_historial set total = v_n where id = v_hid;
  return v_hid;
end;
$$;

grant execute on function public.cerrar_partido(uuid, text, date, jsonb) to anon, authenticated;
