-- Tratjet — initialisation Supabase (à exécuter une seule fois dans
-- SQL Editor > New query, sur supabase.com).
--
-- Une ligne par utilisateur : ses véhicules et trajets favoris en JSON.
-- Les règles RLS garantissent que chaque utilisateur ne lit et n'écrit
-- QUE sa propre ligne (la clé "anon" publique de la page ne donne accès
-- à rien d'autre).

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vehicules jsonb not null default '[]',
  trajets jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "chacun sa ligne" on public.user_data;
create policy "chacun sa ligne" on public.user_data
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
