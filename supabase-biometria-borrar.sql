-- Elimina POR COMPLETO el piloto biométrico de la base de datos (plantillas e intentos).
-- No toca ninguna otra tabla. Es irreversible: las plantillas borradas no se recuperan.
drop table if exists public.biometria_intentos;
drop table if exists public.guardias_biometria;
