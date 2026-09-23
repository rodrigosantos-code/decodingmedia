-- ==============================================================================
-- DECODING MEDIA - CONFIGURACIÓN DE BASE DE DATOS SUPABASE
-- Ejecuta este script completo en el SQL Editor de tu panel de Supabase:
-- https://supabase.com/dashboard/project/_/sql
-- ==============================================================================

-- 1. Crear tabla principal para guardar las escenas y configuración de la presentación
CREATE TABLE IF NOT EXISTS public.dm_decks (
    id TEXT PRIMARY KEY DEFAULT 'default',
    slots JSONB NOT NULL DEFAULT '[]'::jsonb,
    calib_version TEXT DEFAULT '20260923_def_v2',
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_by TEXT DEFAULT 'editor'
);

-- 2. Habilitar Row Level Security (RLS)
ALTER TABLE public.dm_decks ENABLE ROW LEVEL SECURITY;

-- 3. Políticas de acceso público (con clave anon) para permitir leer y escribir
DROP POLICY IF EXISTS "Permitir lectura pública de dm_decks" ON public.dm_decks;
CREATE POLICY "Permitir lectura pública de dm_decks"
    ON public.dm_decks
    FOR SELECT
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "Permitir inserción pública de dm_decks" ON public.dm_decks;
CREATE POLICY "Permitir inserción pública de dm_decks"
    ON public.dm_decks
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir actualización pública de dm_decks" ON public.dm_decks;
CREATE POLICY "Permitir actualización pública de dm_decks"
    ON public.dm_decks
    FOR UPDATE
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

-- 4. Habilitar la replicación en tiempo real (Supabase Realtime) para la tabla dm_decks
-- Esto permite que cualquier cambio guardado en un ordenador se envíe instantáneamente a los demás
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'dm_decks'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_decks;
    END IF;
END $$;

-- 5. Crear fila inicial si no existe
INSERT INTO public.dm_decks (id, slots, calib_version, updated_at, updated_by)
VALUES (
    'default',
    '[]'::jsonb,
    '20260923_def_v2',
    timezone('utc'::text, now()),
    'system_init'
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.dm_decks IS 'Almacén de escenas (slots), calibraciones y configuraciones de Decoding Media';
