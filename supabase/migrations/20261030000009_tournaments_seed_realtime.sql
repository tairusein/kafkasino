-- =============================================================================
-- Kafkasino :: Step 4 / Migration 9 — default featured banner tournament &
--                                      realtime publication for participants
-- =============================================================================

-- Add tournament_participants to Realtime so rosters and seat counts update live.
alter table public.tournament_participants replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.tournament_participants;
    exception when duplicate_object then
      null;
    end;
  end if;
end $$;

-- Seed an initial featured tournament if none is featured yet, so the homepage
-- hero banner is populated out of the box and immediately editable by the Admin.
insert into public.tournaments (
  title,
  description,
  game_type,
  prize_name,
  prize_image_path,
  starts_at,
  entry_fee,
  max_participants,
  status,
  is_featured
)
select
  'The Grand House Invitational',
  'High-stakes championship across the house tables. Registered contenders compete through elimination rounds for the house crest and the grand prize.',
  'blackjack',
  'Royal Gold Chronograph & 50,000 Chips',
  '/tournaments/royal-chronograph.svg',
  date_trunc('hour', now() + interval '7 days') + interval '20 hours',
  1000,
  64,
  'upcoming',
  true
where not exists (
  select 1 from public.tournaments where is_featured
);

