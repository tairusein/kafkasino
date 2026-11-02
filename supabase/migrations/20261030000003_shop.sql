-- =============================================================================
-- Kafkasino :: Step 1 / Migration 3 — shop (card backs, premium interactive emotes)
-- =============================================================================

create table public.shop_items (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  kind           text not null check (kind in ('card_back', 'emote')),
  name           text not null,
  description    text not null default '',
  price          bigint not null check (price >= 0),
  -- Asset reference, e.g. {"svg":"shop-assets/card-backs/gold-crest.svg"} or {"animation":"slap"}
  asset          jsonb not null default '{}'::jsonb,
  is_interactive boolean not null default false,   -- targets another player's avatar
  is_consumable  boolean not null default false,   -- each purchase grants N uses
  grant_quantity int not null default 1 check (grant_quantity > 0),
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint shop_card_back_rules check (kind <> 'card_back' or (not is_consumable and not is_interactive)),
  constraint shop_interactive_is_emote check (not is_interactive or kind = 'emote')
);
create trigger shop_items_set_updated_at
  before update on public.shop_items
  for each row execute function public.set_updated_at();

alter table public.shop_items enable row level security;
create policy shop_items_read on public.shop_items
  for select to authenticated
  using (is_active or public.is_admin());
create policy shop_items_admin_insert on public.shop_items
  for insert to authenticated with check (public.is_admin());
create policy shop_items_admin_update on public.shop_items
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy shop_items_admin_delete on public.shop_items
  for delete to authenticated using (public.is_admin());

-- Inventory: owner-read-only. Only purchase_item() / consume_emote_charge() write.
create table public.user_items (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_id     uuid not null references public.shop_items(id) on delete cascade,
  quantity    int  not null default 1 check (quantity >= 0),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.user_items enable row level security;
create policy user_items_read_own on public.user_items
  for select to authenticated
  using (user_id = (select auth.uid()));

alter table public.profiles
  add constraint profiles_equipped_card_back_fkey
  foreign key (equipped_card_back) references public.shop_items(id) on delete set null;

-- ---------- seed catalogue (prices are relative to the 1000-chip daily bonus) ---
insert into public.shop_items (slug, kind, name, description, price, asset, is_interactive, is_consumable, grant_quantity, sort_order) values
  ('cb-burgundy-classic', 'card_back', 'Burgundy Classic',   'Deep burgundy field with a fine gold border.',       2000,
     '{"svg":"shop-assets/card-backs/burgundy-classic.svg"}', false, false, 1, 10),
  ('cb-graphite-guilloche','card_back','Graphite Guilloché', 'Engraved guilloché pattern on graphite.',            4000,
     '{"svg":"shop-assets/card-backs/graphite-guilloche.svg"}', false, false, 1, 20),
  ('cb-gold-crest',       'card_back', 'Gold Crest',         'Embossed gold crest on burgundy.',                  10000,
     '{"svg":"shop-assets/card-backs/gold-crest.svg"}', false, false, 1, 30),
  ('cb-midnight-lattice', 'card_back', 'Midnight Lattice',   'Fine gold lattice over midnight graphite.',          6000,
     '{"svg":"shop-assets/card-backs/midnight-lattice.svg"}', false, false, 1, 40),
  ('cb-royal-monogram',   'card_back', 'Royal Monogram',     'Hand-set K monogram in polished gold.',             20000,
     '{"svg":"shop-assets/card-backs/royal-monogram.svg"}', false, false, 1, 50),

  ('em-slap',   'emote', 'The Slap',        'Your avatar delivers a crisp slap to an opponent.',      300, '{"animation":"slap"}',   true,  true, 5, 100),
  ('em-punch',  'emote', 'The Punch',       'A swift punch lands on your chosen opponent.',           400, '{"animation":"punch"}',  true,  true, 5, 110),
  ('em-poop',   'emote', 'Special Delivery','Hurl a certain brown item at an opponent.',              500, '{"animation":"poop"}',   true,  true, 5, 120),
  ('em-tomato', 'emote', 'Rotten Tomato',   'Splat! A tomato finds its target.',                      300, '{"animation":"tomato"}', true,  true, 5, 130),
  ('em-toast',  'emote', 'Champagne Toast', 'Raise a glass to a worthy opponent.',                    200, '{"animation":"toast"}',  true,  true, 5, 140);

-- ---------- purchase -----------------------------------------------------------
-- Atomic: debit + inventory grant in one transaction. Server computes the price;
-- the client never supplies it. p_idempotency_key makes double-clicks harmless.
create or replace function public.purchase_item(
  p_item_id         uuid,
  p_quantity        int  default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_uid();
  v_item    public.shop_items;
  v_qty     int  := coalesce(p_quantity, 1);
  v_total   bigint;
  v_units   int;
  v_key     text;
  v_balance bigint;
  v_owned   int;
begin
  -- Serialise this user's money operations first.
  perform 1 from public.wallets where user_id = v_uid for update;
  if not found then raise exception 'wallet_not_found'; end if;

  select * into v_item from public.shop_items where id = p_item_id and is_active;
  if not found then raise exception 'item_not_found'; end if;

  -- Replay check comes first: a retried request must report the original outcome,
  -- not trip the "already owned" rule it caused itself.
  if p_idempotency_key is not null then
    v_key := 'purchase:' || v_uid::text || ':' || p_idempotency_key;
    if exists (select 1 from public.wallet_transactions where idempotency_key = v_key) then
      select balance into v_balance from public.wallets where user_id = v_uid;
      select quantity into v_owned from public.user_items
        where user_id = v_uid and item_id = v_item.id;
      return jsonb_build_object('balance', v_balance, 'item_id', v_item.id,
                                'quantity', coalesce(v_owned, 0), 'replayed', true);
    end if;
  end if;

  if v_item.is_consumable then
    if v_qty < 1 or v_qty > 100 then raise exception 'invalid_quantity'; end if;
  else
    v_qty := 1;
    if exists (select 1 from public.user_items where user_id = v_uid and item_id = v_item.id) then
      raise exception 'already_owned';
    end if;
  end if;

  v_total := v_item.price * v_qty;
  v_units := v_item.grant_quantity * v_qty;

  if v_total > 0 then
    v_balance := public.apply_balance_delta(
      v_uid, -v_total, 'purchase', 'shop_item', v_item.id::text, v_key,
      jsonb_build_object('slug', v_item.slug, 'quantity', v_qty, 'units', v_units)
    );
  else
    select balance into v_balance from public.wallets where user_id = v_uid;
  end if;

  insert into public.user_items (user_id, item_id, quantity)
  values (v_uid, v_item.id, v_units)
  on conflict (user_id, item_id)
  do update set quantity = public.user_items.quantity + excluded.quantity
  returning quantity into v_owned;

  return jsonb_build_object('balance', v_balance, 'item_id', v_item.id,
                            'quantity', v_owned, 'replayed', false);
end;
$$;

-- Equip an owned card back (NULL = restore the default).
create or replace function public.equip_card_back(p_item_id uuid default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if p_item_id is not null then
    if not exists (
      select 1
        from public.user_items ui
        join public.shop_items si on si.id = ui.item_id
       where ui.user_id = v_uid and ui.item_id = p_item_id and si.kind = 'card_back'
    ) then
      raise exception 'item_not_owned';
    end if;
  end if;
  update public.profiles set equipped_card_back = p_item_id where id = v_uid;
end;
$$;

-- Internal (service_role / other definer RPCs only): spend one emote charge.
-- Used by the realtime game layer (Step 6) when an interactive emote is sent.
create or replace function public.consume_emote_charge(p_user uuid, p_item_id uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_left int;
begin
  update public.user_items ui
     set quantity = ui.quantity - 1
    from public.shop_items si
   where ui.user_id = p_user and ui.item_id = p_item_id
     and si.id = ui.item_id and si.kind = 'emote'
     and ui.quantity > 0
  returning ui.quantity into v_left;
  if not found then
    raise exception 'no_charges_left';
  end if;
  return v_left;
end;
$$;
