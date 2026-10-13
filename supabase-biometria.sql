-- =====================================================================
--  PILOTO BIOMÉTRICO (Etapa 1) — tablas CERRADAS  ·  Control de Guardias
-- =====================================================================
--  Ejecutar UNA VEZ en Supabase -> SQL Editor (se puede repetir sin riesgo).
--  NO modifica ninguna tabla existente (ni asistencias, ni guardias_central).
--
--  Seguridad:
--   - RLS ACTIVADO y SIN NINGUNA POLÍTICA: la anon key (la que usa la página) NO puede leer,
--     escribir ni ver estas tablas. Solo la función de Netlify "biometria", con la
--     service_role key (variable de entorno de Netlify), puede usarlas.
--   - No se agregan al tiempo real (realtime).
--   - La plantilla se guarda CIFRADA (AES-256-GCM) con una clave que existe solo en Netlify.
--   - No se guardan imágenes: solo la plantilla cifrada y el resultado de cada intento.
--  Para eliminar TODO lo biométrico: supabase-biometria-borrar.sql
-- =====================================================================

create table if not exists public.guardias_biometria (
  rut                  text primary key,              -- RUT normalizado (12345678-9)
  plantilla            text not null,                 -- "v1:" + base64(iv|tag|cifrado) — AES-256-GCM, AAD = rut
  modelo               text not null,                 -- p. ej. "yunet-2023mar+sface-2021dec-fp32"
  version              integer not null default 1,    -- sube con cada re-enrolamiento
  muestras             integer not null default 0,    -- imágenes frontales promediadas
  fecha_enrolamiento   timestamptz not null default now(),
  consentimiento_fecha timestamptz not null,          -- consentimiento explícito registrado al enrolar
  enrolado_por         text,                          -- "admin-pin" (piloto)
  activo               boolean not null default true
);

create table if not exists public.biometria_intentos (
  id            uuid primary key default gen_random_uuid(),
  rut           text not null,
  tipo          text not null check (tipo in ('enrolamiento', 'verificacion')),
  estado        text not null,                       -- VERIFICADO | REVISIÓN MANUAL | NO COINCIDE | ENROLADO | RECHAZADO
  score         real,                                -- coseno contra la plantilla (verificación)
  liveness_ok   boolean,
  detalle       jsonb,                               -- motivos y medidas (sin imágenes ni embeddings)
  modelo        text,
  metodo        text,                                -- "desafio-giro-v1"
  nonce         text unique,                         -- desafío de un solo uso
  duracion_ms   integer,
  asistencia_id uuid,                                -- Etapa 2 (opcional); en la Etapa 1 queda vacío
  fecha         timestamptz not null default now()
);
create index if not exists idx_bio_intentos_rut_fecha on public.biometria_intentos (rut, fecha desc);

alter table public.guardias_biometria enable row level security;
alter table public.biometria_intentos enable row level security;
-- Sin políticas a propósito. Además se quitan los permisos de los roles públicos.
revoke all on public.guardias_biometria from anon, authenticated;
revoke all on public.biometria_intentos from anon, authenticated;
