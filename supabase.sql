-- =====================================================================
--  CONTROL DE GUARDIAS OS10 — Estructura de base de datos (Supabase)
--  Pega TODO este archivo en:  Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- TABLAS ----------
create table if not exists eventos (
  id                uuid primary key default gen_random_uuid(),
  nombre_evento     text not null,
  empresa           text not null,
  cantidad_esperada integer default 0,
  fecha_evento      date,
  slug              text unique not null,
  activo            boolean default true,
  tipo              text default 'evento',     -- 'evento' o 'partido'
  partido           text,                       -- si es partido: equipos (ej: La Serena vs Huachipato)
  usa_turnos        boolean default true,       -- false = evento corto sin turnos (los partidos siempre false)
  turno_horas       integer default 12,        -- duración del turno en horas (ej: 12 = día/noche)
  turno_inicio      text default '08:00',      -- hora de inicio del 1er turno (HH:MM)
  created_at        timestamptz default now()
);

-- Migración para bases ya existentes (agrega las columnas si faltan):
alter table eventos add column if not exists turno_horas  integer default 12;
alter table eventos add column if not exists turno_inicio text    default '08:00';
alter table eventos add column if not exists tipo         text    default 'evento';
alter table eventos add column if not exists partido      text;
alter table eventos add column if not exists usa_turnos   boolean default true;

create table if not exists guardias_central (
  rut                 text primary key,          -- formateado: 12345678-9
  nombres             text,                       -- MAYÚSCULAS (2 nombres)
  apellidos           text,                       -- MAYÚSCULAS (2 apellidos)
  telefono            text,
  fecha_ultimo_examen date,
  updated_at          timestamptz default now()
);

create table if not exists asistencias (
  id           uuid primary key default gen_random_uuid(),
  evento_id    uuid references eventos(id) on delete cascade,
  rut          text references guardias_central(rut),
  hora_ingreso timestamptz default now(),
  unique (evento_id, rut)                          -- un guardia no se duplica en un evento
);

create index if not exists idx_asist_evento on asistencias(evento_id);
create index if not exists idx_asist_rut    on asistencias(rut);

-- ---------- SEGURIDAD (RLS) ----------
-- El formulario del guardia y el panel usan la ANON KEY pública.
-- Estas políticas permiten leer/registrar. (Ver nota de seguridad en INSTRUCCIONES.md)
alter table eventos          enable row level security;
alter table guardias_central enable row level security;
alter table asistencias      enable row level security;

drop policy if exists "acceso_eventos"     on eventos;
drop policy if exists "acceso_guardias"    on guardias_central;
drop policy if exists "acceso_asistencias" on asistencias;

create policy "acceso_eventos"     on eventos          for all using (true) with check (true);
create policy "acceso_guardias"    on guardias_central for all using (true) with check (true);
create policy "acceso_asistencias" on asistencias      for all using (true) with check (true);

-- ---------- TIEMPO REAL ----------
alter publication supabase_realtime add table eventos;
alter publication supabase_realtime add table guardias_central;
alter publication supabase_realtime add table asistencias;
