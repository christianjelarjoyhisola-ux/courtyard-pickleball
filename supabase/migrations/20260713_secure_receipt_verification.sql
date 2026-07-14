-- Secure receipt-verification capabilities and public write boundaries.
--
-- A browser creates 32 cryptographically-random bytes and base64url-encodes
-- them without padding (43 characters). Only the lowercase SHA-256 hex digest
-- of that exact UTF-8 string is stored. The raw token is presented to the
-- Edge Function (and the two narrowly-scoped hold RPCs below), hashed again,
-- and compared with the stored digest.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;


-- --------------------------------------------------------------------------
-- 1. Capability state on both receipt-bearing targets
-- --------------------------------------------------------------------------

alter table public.bookings
  add column if not exists receipt_upload_token_hash       text,
  add column if not exists receipt_upload_token_expires_at timestamptz,
  add column if not exists receipt_upload_token_used_at    timestamptz;

alter table public.open_play_registrations
  add column if not exists receipt_upload_token_hash       text,
  add column if not exists receipt_upload_token_expires_at timestamptz,
  add column if not exists receipt_upload_token_used_at    timestamptz;

alter table public.bookings
  drop constraint if exists bookings_receipt_upload_token_check;
alter table public.bookings
  add constraint bookings_receipt_upload_token_check check (
    (
      receipt_upload_token_hash is null
      and receipt_upload_token_expires_at is null
      and receipt_upload_token_used_at is null
    )
    or
    (
      receipt_upload_token_hash ~ '^[0-9a-f]{64}$'
      and receipt_upload_token_expires_at is not null
    )
  );

alter table public.open_play_registrations
  drop constraint if exists open_play_receipt_upload_token_check;
alter table public.open_play_registrations
  add constraint open_play_receipt_upload_token_check check (
    (
      receipt_upload_token_hash is null
      and receipt_upload_token_expires_at is null
      and receipt_upload_token_used_at is null
    )
    or
    (
      receipt_upload_token_hash ~ '^[0-9a-f]{64}$'
      and receipt_upload_token_expires_at is not null
    )
  );

create unique index if not exists uniq_bookings_receipt_upload_token_hash
  on public.bookings (receipt_upload_token_hash)
  where receipt_upload_token_hash is not null;

create unique index if not exists uniq_open_play_receipt_upload_token_hash
  on public.open_play_registrations (receipt_upload_token_hash)
  where receipt_upload_token_hash is not null;

-- The database, rather than an untrusted caller, fixes each capability to a
-- 15-minute lifetime. Changing a hash rotates the capability and clears its
-- consumed marker. Existing rows without a capability remain valid.
create or replace function public.set_receipt_upload_token_lifetime()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.receipt_upload_token_hash is null then
    new.receipt_upload_token_expires_at := null;
    new.receipt_upload_token_used_at := null;
  elsif tg_op = 'INSERT' then
    new.receipt_upload_token_expires_at := coalesce(new.created_at, statement_timestamp())
      + interval '15 minutes';
    new.receipt_upload_token_used_at := null;
  elsif new.receipt_upload_token_hash is distinct from old.receipt_upload_token_hash then
    new.receipt_upload_token_expires_at := statement_timestamp() + interval '15 minutes';
    new.receipt_upload_token_used_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bookings_receipt_upload_token_lifetime on public.bookings;
create trigger trg_bookings_receipt_upload_token_lifetime
  before insert or update of receipt_upload_token_hash
  on public.bookings
  for each row execute function public.set_receipt_upload_token_lifetime();

drop trigger if exists trg_open_play_receipt_upload_token_lifetime
  on public.open_play_registrations;
create trigger trg_open_play_receipt_upload_token_lifetime
  before insert or update of receipt_upload_token_hash
  on public.open_play_registrations
  for each row execute function public.set_receipt_upload_token_lifetime();


-- --------------------------------------------------------------------------
-- 2. Current lifecycle constraints (also repairs fresh installs whose setup
--    snapshot predates verifying/rejected)
-- --------------------------------------------------------------------------

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending', 'verifying', 'confirmed', 'cancelled', 'completed'));

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in (
    'unpaid',
    'pending',
    'for_verification',
    'downpayment_paid',
    'paid',
    'failed',
    'rejected'
  ));


-- --------------------------------------------------------------------------
-- 3. Race-safe slot conflict check with self-expiring verification holds
-- --------------------------------------------------------------------------

create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  -- Serialize contenders for the same court/day. The prior trigger's plain
  -- SELECT allowed two simultaneous inserts to both observe an empty slot.
  perform pg_advisory_xact_lock(
    hashtextextended('booking:' || new.court_id || ':' || new.date::text, 0)
  );

  if exists (
    select 1
    from public.bookings b
    where b.court_id = new.court_id
      and b.date = new.date
      and b.ref <> new.ref
      and b.status <> 'cancelled'
      -- A verification hold occupies its slots for only 15 minutes. Missing
      -- timestamps are treated conservatively as active.
      and (
        b.status <> 'verifying'
        or b.created_at is null
        or b.created_at >= statement_timestamp() - interval '15 minutes'
      )
      and b.slots && new.slots
  ) then
    raise exception 'One or more time slots are already booked for this court and date.'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists check_booking_conflict on public.bookings;
create trigger check_booking_conflict
  before insert or update on public.bookings
  for each row execute function public.prevent_double_booking();


-- --------------------------------------------------------------------------
-- 4. Conservative public writes
-- --------------------------------------------------------------------------

alter table public.bookings enable row level security;

-- Remove the historical WITH CHECK (true) policy. Anonymous callers can only
-- create a fresh, unverified hold. There is intentionally no anonymous UPDATE
-- policy; hold changes go through the capability-checked RPCs below.
drop policy if exists bookings_insert_public on public.bookings;
drop policy if exists bookings_insert_anon_hold on public.bookings;
drop policy if exists bookings_insert_authenticated on public.bookings;
drop policy if exists bookings_update_public on public.bookings;
drop policy if exists bookings_update_anon on public.bookings;

create policy bookings_insert_anon_hold
on public.bookings
for insert
to anon
with check (
  ref ~ '^PB-[A-Z0-9]+-[A-Z0-9]{4}$'
  and full_name = 'Reserving…'
  and contact_number = '00000000000'
  and email = 'reserve@hold.internal'
  and status = 'verifying'
  and payment_status = 'for_verification'
  and payment_method = 'gcash'
  and payment_flow is null
  and created_at >= statement_timestamp() - interval '2 minutes'
  and created_at <= statement_timestamp() + interval '1 minute'
  and receipt_upload_token_hash ~ '^[0-9a-f]{64}$'
  and receipt_upload_token_expires_at = created_at + interval '15 minutes'
  and receipt_upload_token_used_at is null
  and paid_at is null
  and payment_provider is null
  and payment_session_id is null
  and payment_checkout_url is null
  and gcash_ref is null
  and downpayment is null
  and receipt_status = 'none'
  and receipt_image_url is null
  and receipt_image_hash is null
  and receipt_phash is null
  and cardinality(receipt_flags) = 0
  and receipt_extracted is null
  and receipt_confidence is null
  and receipt_verified_at is null
  and billed_at is null
  and weekly_fee_id is null
);

-- Dashboard users retain their existing ability to create bookings. Payment
-- authority here is limited to authenticated staff; the service role bypasses
-- RLS for Edge Function work.
create policy bookings_insert_authenticated
on public.bookings
for insert
to authenticated
with check (auth.uid() is not null);

alter table public.open_play_registrations enable row level security;

drop policy if exists open_play_insert_public on public.open_play_registrations;
drop policy if exists open_play_insert_anon_pending on public.open_play_registrations;
drop policy if exists open_play_insert_authenticated on public.open_play_registrations;
drop policy if exists open_play_update_public on public.open_play_registrations;
drop policy if exists open_play_update_anon on public.open_play_registrations;
drop policy if exists open_play_update_admin on public.open_play_registrations;

create policy open_play_insert_anon_pending
on public.open_play_registrations
for insert
to anon
with check (
  payment_status = 'pending'
  and created_at >= statement_timestamp() - interval '2 minutes'
  and created_at <= statement_timestamp() + interval '1 minute'
  and payment_method in ('cash', 'gcash', 'gotyme', 'pnb')
  and (
    (
      payment_method = 'cash'
      and receipt_upload_token_hash is null
      and receipt_upload_token_expires_at is null
      and receipt_upload_token_used_at is null
    )
    or
    (
      payment_method in ('gcash', 'gotyme', 'pnb')
      and receipt_upload_token_hash ~ '^[0-9a-f]{64}$'
      and receipt_upload_token_expires_at = created_at + interval '15 minutes'
      and receipt_upload_token_used_at is null
    )
  )
  and receipt_status = 'none'
  and receipt_image_url is null
  and receipt_image_hash is null
  and receipt_phash is null
  and cardinality(receipt_flags) = 0
  and receipt_extracted is null
  and receipt_confidence is null
  and receipt_verified_at is null
);

create policy open_play_insert_authenticated
on public.open_play_registrations
for insert
to authenticated
with check (auth.uid() is not null);

create policy open_play_update_admin
on public.open_play_registrations
for update
to authenticated
using (auth.uid() is not null)
with check (auth.uid() is not null);


-- --------------------------------------------------------------------------
-- 5. Narrow anonymous hold mutations
-- --------------------------------------------------------------------------

-- PostgreSQL cannot widen an existing function's OUT-row shape with
-- CREATE OR REPLACE, so drop this exact signature before adding quote fields.
drop function if exists public.finalize_public_booking_hold(
  text, text, text, text, text, text, text, text
);

create or replace function public.finalize_public_booking_hold(
  p_booking_ref text,
  p_raw_token text,
  p_full_name text,
  p_contact_number text,
  p_email text,
  p_payment_method text,
  p_payment_choice text default 'downpayment',
  p_payment_reference text default null
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text,
  court_name text,
  start_time text,
  end_time text,
  duration integer,
  slots text[],
  total_due numeric,
  amount_due numeric
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  v_booking public.bookings%rowtype;
  v_now timestamptz := statement_timestamp();
  v_token_hash text;
  v_method text := regexp_replace(
    lower(btrim(coalesce(p_payment_method, ''))), '[[:space:]_-]', '', 'g'
  );
  v_choice text := lower(btrim(coalesce(p_payment_choice, 'downpayment')));
  v_reference text;
  v_status text;
  v_payment_status text;
  v_method_enabled text;
  v_acceptance_mode text;
  v_court_name text;
  v_court_rate numeric;
  v_court_blocked boolean;
  v_court_schedule jsonb;
  v_parsed_schedule jsonb;
  v_pricing_tiers_text text;
  v_tiers jsonb := '[]'::jsonb;
  v_tier jsonb;
  v_tier_from numeric;
  v_tier_to numeric;
  v_tier_rate numeric;
  v_slot_rate numeric;
  v_slot_text text;
  v_slot integer;
  v_slots integer[] := '{}'::integer[];
  v_canonical_slots text[];
  v_min_slot integer;
  v_max_slot integer;
  v_open_text text;
  v_close_text text;
  v_open_hour integer;
  v_close_hour integer;
  v_court_total numeric := 0;
  v_fee_text text;
  v_fee_type text;
  v_service_fee_rate numeric;
  v_service_fee numeric;
  v_total numeric;
  v_due numeric;
  v_start_time text;
  v_end_time text;
begin
  if p_booking_ref is null
     or p_booking_ref !~ '^PB-[A-Z0-9]+-[A-Z0-9]{4}$'
     or p_raw_token is null
     or p_raw_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Booking hold is invalid or expired.' using errcode = 'P0001';
  end if;

  v_token_hash := encode(digest(convert_to(p_raw_token, 'UTF8'), 'sha256'), 'hex');

  select b.*
    into v_booking
    from public.bookings b
   where b.ref = p_booking_ref
   for update;

  if not found
     or v_booking.status <> 'verifying'
     or v_booking.created_at < v_now - interval '15 minutes'
     or v_booking.receipt_upload_token_hash is distinct from v_token_hash
     or v_booking.receipt_upload_token_expires_at is null
     or v_booking.receipt_upload_token_expires_at <= v_now
     or v_booking.receipt_upload_token_used_at is not null then
    raise exception 'Booking hold is invalid or expired.' using errcode = 'P0001';
  end if;

  if v_booking.full_name <> 'Reserving…'
     or v_booking.contact_number <> '00000000000'
     or v_booking.email <> 'reserve@hold.internal'
     or v_booking.payment_flow is not null then
    -- A digital finalization keeps the one-time capability alive solely for
    -- the imminent receipt upload. A retry after an ambiguous RPC response is
    -- read-only and returns the committed state; it can never change details.
    if v_booking.payment_method in ('gcash', 'gotyme', 'pnb')
       and v_booking.payment_flow = v_booking.payment_method
       and v_booking.payment_status = 'for_verification'
       and v_booking.receipt_status = 'none'
       and v_booking.gcash_ref is not null
       and v_booking.total is not null
       and v_booking.downpayment is not null then
      return query select
        v_booking.ref, v_booking.status, v_booking.payment_status,
        v_booking.court_name, v_booking.start_time, v_booking.end_time,
        v_booking.duration::integer, v_booking.slots, v_booking.total,
        v_booking.downpayment;
      return;
    end if;
    raise exception 'Booking hold has already been finalized.' using errcode = 'P0001';
  end if;

  if length(btrim(coalesce(p_full_name, ''))) not between 3 and 150
     or p_full_name ~ '[[:cntrl:]<>]' then
    raise exception 'Full name must be between 3 and 150 characters.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_contact_number, ''))) not between 7 and 32
     or p_contact_number ~ '[[:cntrl:]<>]' then
    raise exception 'Contact number must be between 7 and 32 characters.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_email, ''))) not between 3 and 320
     or position('@' in p_email) = 0
     or p_email ~ '[[:cntrl:]<>]' then
    raise exception 'A valid email address is required.' using errcode = '22023';
  end if;

  -- The hold protects occupancy only. Treat all of its descriptive and pricing
  -- fields as untrusted until they have been rebuilt from current DB state.
  if v_booking.date < timezone('Asia/Manila', v_now)::date then
    raise exception 'Booking date has already passed.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.blocked_dates d where d.date = v_booking.date
  ) then
    raise exception 'The venue is closed on this date.' using errcode = '22023';
  end if;

  select c.name, c.rate, c.blocked, c.rate_schedule
    into v_court_name, v_court_rate, v_court_blocked, v_court_schedule
  from public.courts c
  where c.id = v_booking.court_id
  for share;
  if not found or v_court_blocked then
    raise exception 'Court is unavailable.' using errcode = '22023';
  end if;
  if v_court_rate is null
     or v_court_rate::text in ('NaN', 'Infinity', '-Infinity')
     or v_court_rate < 0 then
    raise exception 'Court rate is invalid.' using errcode = '22023';
  end if;

  select s.value into v_open_text from public.settings s where s.key = 'open_hour';
  if not found then
    select s.value into v_open_text from public.settings s where s.key = 'open_time';
  end if;
  select s.value into v_close_text from public.settings s where s.key = 'close_hour';
  if not found then
    select s.value into v_close_text from public.settings s where s.key = 'close_time';
  end if;
  begin
    v_open_hour := coalesce(nullif(btrim(v_open_text), ''), '6')::integer;
    v_close_hour := coalesce(nullif(btrim(v_close_text), ''), '22')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Operating hours are invalid.' using errcode = '22023';
  end;
  if v_open_hour < 0 or v_close_hour > 24 or v_close_hour <= v_open_hour then
    raise exception 'Operating hours are invalid.' using errcode = '22023';
  end if;

  if coalesce(cardinality(v_booking.slots), 0) = 0
     or cardinality(v_booking.slots) > 24 then
    raise exception 'Booking has no valid billable slots.' using errcode = '22023';
  end if;
  foreach v_slot_text in array v_booking.slots loop
    v_slot_text := btrim(coalesce(v_slot_text, ''));
    if v_slot_text !~ '^(0|[1-9]|1[0-9]|2[0-3])$' then
      raise exception 'Booking slots must be whole hours from 0 through 23.'
        using errcode = '22023';
    end if;
    v_slot := v_slot_text::integer;
    if v_slot < v_open_hour or v_slot >= v_close_hour then
      raise exception 'Booking contains a slot outside operating hours.'
        using errcode = '22023';
    end if;
    if v_slot = any(v_slots) then
      raise exception 'Booking slots must be unique.' using errcode = '22023';
    end if;
    v_slots := array_append(v_slots, v_slot);
  end loop;

  select array_agg(u.slot order by u.slot), min(u.slot), max(u.slot)
    into v_slots, v_min_slot, v_max_slot
  from unnest(v_slots) as u(slot);
  if exists (
    select 1
    from generate_subscripts(v_slots, 1) as g(i)
    where g.i > 1 and v_slots[g.i] <> v_slots[g.i - 1] + 1
  ) then
    raise exception 'Booking slots must be consecutive.' using errcode = '22023';
  end if;
  if v_booking.date = timezone('Asia/Manila', v_now)::date
     and v_min_slot <= extract(hour from timezone('Asia/Manila', v_now))::integer then
    raise exception 'Booking slot has already started.' using errcode = '22023';
  end if;
  select array_agg(u.slot::text order by u.slot)
    into v_canonical_slots
  from unnest(v_slots) as u(slot);

  -- A nonempty court schedule wins even when all of its entries are invalid;
  -- invalid/unmatched entries fall back to the court's base rate, exactly like
  -- the Edge verifier. Only an empty/unparseable court schedule uses globals.
  if jsonb_typeof(v_court_schedule) = 'array'
     and jsonb_array_length(v_court_schedule) > 0 then
    v_tiers := v_court_schedule;
  elsif jsonb_typeof(v_court_schedule) = 'string' then
    begin
      v_parsed_schedule := (v_court_schedule #>> '{}')::jsonb;
    exception when others then
      v_parsed_schedule := '[]'::jsonb;
    end;
    if jsonb_typeof(v_parsed_schedule) = 'array'
       and jsonb_array_length(v_parsed_schedule) > 0 then
      v_tiers := v_parsed_schedule;
    end if;
  end if;
  if jsonb_array_length(v_tiers) = 0 then
    select s.value into v_pricing_tiers_text
    from public.settings s where s.key = 'pricing_tiers';
    begin
      v_parsed_schedule := coalesce(nullif(btrim(v_pricing_tiers_text), ''), '[]')::jsonb;
    exception when others then
      v_parsed_schedule := '[]'::jsonb;
    end;
    if jsonb_typeof(v_parsed_schedule) = 'array' then
      v_tiers := v_parsed_schedule;
    end if;
  end if;

  foreach v_slot in array v_slots loop
    v_slot_rate := v_court_rate;
    for v_tier in select value from jsonb_array_elements(v_tiers) loop
      begin
        v_tier_from := (v_tier ->> 'from')::numeric;
        v_tier_to := (v_tier ->> 'to')::numeric;
        v_tier_rate := (v_tier ->> 'rate')::numeric;
      exception when invalid_text_representation or numeric_value_out_of_range then
        continue;
      end;
      if v_tier_from is null or v_tier_to is null or v_tier_rate is null
         or v_tier_from::text in ('NaN', 'Infinity', '-Infinity')
         or v_tier_to::text in ('NaN', 'Infinity', '-Infinity')
         or v_tier_rate::text in ('NaN', 'Infinity', '-Infinity')
         or v_tier_rate < 0 then
        continue;
      end if;
      if (v_tier_from < v_tier_to
          and v_slot >= v_tier_from and v_slot < v_tier_to)
         or (v_tier_from >= v_tier_to
             and (v_slot >= v_tier_from or v_slot < v_tier_to)) then
        v_slot_rate := v_tier_rate;
        exit;
      end if;
    end loop;
    v_court_total := v_court_total + v_slot_rate;
  end loop;
  v_court_total := round(v_court_total, 2);

  select s.value into v_fee_text from public.settings s where s.key = 'maintenance_fee';
  if not found then
    select s.value into v_fee_text from public.settings s where s.key = 'service_fee_rate';
  end if;
  if not found then
    select s.value into v_fee_text from public.settings s where s.key = 'booking_fee';
  end if;
  begin
    v_service_fee_rate := coalesce(nullif(btrim(v_fee_text), ''), '0')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_service_fee_rate := 0;
  end;
  if v_service_fee_rate::text in ('NaN', 'Infinity', '-Infinity') then
    v_service_fee_rate := 0;
  elsif v_service_fee_rate < 0 then
    raise exception 'Booking fee is invalid.' using errcode = '22023';
  end if;
  select s.value into v_fee_type from public.settings s where s.key = 'fee_type';
  v_service_fee := round(
    v_service_fee_rate * case
      when lower(coalesce(v_fee_type, '')) = 'flat' then 1
      else cardinality(v_slots)
    end,
    2
  );
  v_total := round(v_court_total + v_service_fee, 2);

  if v_method not in ('cash', 'gcash', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;
  if v_choice not in ('downpayment', 'full') then
    raise exception 'Payment choice must be downpayment or full.' using errcode = '22023';
  end if;
  select s.value into v_method_enabled
  from public.settings s where s.key = 'payment_method_' || v_method;
  if coalesce(lower(btrim(v_method_enabled)), '0') not in ('1', 'true', 'yes', 'on') then
    raise exception 'Selected payment method is disabled.' using errcode = '22023';
  end if;
  select lower(btrim(s.value)) into v_acceptance_mode
  from public.settings s where s.key = 'payment_acceptance_mode';
  v_acceptance_mode := coalesce(v_acceptance_mode, 'both');
  if (v_acceptance_mode = 'full_payment_only' and v_choice <> 'full')
     or (v_acceptance_mode = 'downpayment_only' and v_choice <> 'downpayment') then
    raise exception 'Selected payment amount is not currently accepted.'
      using errcode = '22023';
  end if;

  if length(coalesce(p_payment_reference, '')) > 100 then
    raise exception 'Payment reference is too long.' using errcode = '22023';
  end if;
  if v_method = 'cash' then
    if nullif(btrim(coalesce(p_payment_reference, '')), '') is not null then
      raise exception 'Cash booking must not contain a payment reference.'
        using errcode = '22023';
    end if;
    v_reference := null;
  elsif v_method = 'gcash' then
    v_reference := regexp_replace(
      coalesce(p_payment_reference, ''), '[^0-9]', '', 'g'
    );
    if v_reference !~ '^[0-9]{13}$' then
      raise exception 'GCash reference must contain exactly 13 digits.'
        using errcode = '22023';
    end if;
  else
    v_reference := upper(regexp_replace(
      coalesce(p_payment_reference, ''), '[^A-Za-z0-9]', '', 'g'
    ));
    if v_reference !~ '^[A-Z0-9]{6,40}$' then
      raise exception 'Bank reference must contain 6 to 40 letters or digits.'
        using errcode = '22023';
    end if;
  end if;

  v_due := case when v_choice = 'full'
    then v_total else round(v_total / 2, 2) end;
  v_start_time := case
    when v_min_slot = 0 then '12:00 AM'
    when v_min_slot < 12 then v_min_slot::text || ':00 AM'
    when v_min_slot = 12 then '12:00 PM'
    else (v_min_slot - 12)::text || ':00 PM'
  end;
  v_end_time := case
    when v_max_slot + 1 in (0, 24) then '12:00 AM'
    when v_max_slot + 1 < 12 then (v_max_slot + 1)::text || ':00 AM'
    when v_max_slot + 1 = 12 then '12:00 PM'
    else (v_max_slot - 11)::text || ':00 PM'
  end;

  if v_method = 'cash' then
    v_status := 'pending';
    v_payment_status := 'unpaid';
  else
    v_status := 'verifying';
    v_payment_status := 'for_verification';
  end if;

  perform set_config('app.public_booking_finalization', '1', true);
  update public.bookings b
     set full_name = btrim(p_full_name),
         contact_number = btrim(p_contact_number),
         email = btrim(p_email),
         court_name = v_court_name,
         slots = v_canonical_slots,
         start_time = v_start_time,
         end_time = v_end_time,
         duration = cardinality(v_slots),
         rate = v_court_rate,
         total = v_total,
         payment_method = v_method,
         payment_flow = v_method,
         gcash_ref = v_reference,
         downpayment = v_due,
         status = v_status,
         payment_status = v_payment_status,
         -- Cash requires no receipt, so consume its capability immediately.
         receipt_upload_token_used_at = case
           when v_method = 'cash' then v_now
           else b.receipt_upload_token_used_at
         end
   where b.ref = p_booking_ref;

  return query
  select p_booking_ref, v_status, v_payment_status,
    v_court_name, v_start_time, v_end_time, cardinality(v_slots),
    v_canonical_slots, v_total, v_due;
end;
$$;

create or replace function public.cancel_public_booking_hold(
  p_booking_ref text,
  p_raw_token text
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
declare
  v_booking public.bookings%rowtype;
  v_now timestamptz := statement_timestamp();
  v_token_hash text;
begin
  if p_booking_ref is null
     or p_booking_ref !~ '^PB-[A-Z0-9]+-[A-Z0-9]{4}$'
     or p_raw_token is null
     or p_raw_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Booking hold is invalid or expired.' using errcode = 'P0001';
  end if;

  v_token_hash := encode(digest(convert_to(p_raw_token, 'UTF8'), 'sha256'), 'hex');

  select b.*
    into v_booking
    from public.bookings b
   where b.ref = p_booking_ref
   for update;

  if not found
     or v_booking.status <> 'verifying'
     or v_booking.full_name <> 'Reserving…'
     or v_booking.contact_number <> '00000000000'
     or v_booking.email <> 'reserve@hold.internal'
     or v_booking.payment_flow is not null
     or v_booking.created_at < v_now - interval '15 minutes'
     or v_booking.receipt_upload_token_hash is distinct from v_token_hash
     or v_booking.receipt_upload_token_expires_at is null
     or v_booking.receipt_upload_token_expires_at <= v_now
     or v_booking.receipt_upload_token_used_at is not null then
    raise exception 'Booking hold is invalid or expired.' using errcode = 'P0001';
  end if;

  update public.bookings b
     set status = 'cancelled',
         payment_status = 'rejected',
         receipt_upload_token_used_at = v_now
   where b.ref = p_booking_ref;

  return query
  select p_booking_ref, 'cancelled'::text, 'rejected'::text;
end;
$$;

revoke all on function public.finalize_public_booking_hold(
  text, text, text, text, text, text, text, text
) from public;
revoke all on function public.cancel_public_booking_hold(text, text) from public;

grant execute on function public.finalize_public_booking_hold(
  text, text, text, text, text, text, text, text
) to anon, authenticated;
grant execute on function public.cancel_public_booking_hold(text, text)
  to anon, authenticated;


-- --------------------------------------------------------------------------
-- 6. Normalize the historical payment-reference ledger
-- --------------------------------------------------------------------------

-- New verifier lookups are provider-scoped so identical identifiers issued by
-- different banks do not collide. Preserve every distinct normalized claim;
-- when legacy formatting variants collapse to one key, retain the earliest
-- claim so that reference remains blocked against replay.
create temporary table receipt_ref_rekey as
with parsed as (
  select
    u.gcash_ref as old_key,
    u.booking_ref,
    u.used_at,
    case
      when lower(split_part(u.gcash_ref, ':', 1)) in ('gcash', 'gotyme', 'pnb')
        then lower(split_part(u.gcash_ref, ':', 1))
      when lower(btrim(coalesce(u.provider, ''))) in ('gcash', 'gotyme', 'pnb')
        then lower(btrim(u.provider))
      else 'gcash'
    end as provider_key,
    case
      when lower(split_part(u.gcash_ref, ':', 1)) in ('gcash', 'gotyme', 'pnb')
        then substring(u.gcash_ref from position(':' in u.gcash_ref) + 1)
      else u.gcash_ref
    end as reference_body
  from public.used_gcash_refs u
), normalized as (
  select
    p.*,
    case
      when p.provider_key = 'gcash'
        then regexp_replace(p.reference_body, '[^0-9]', '', 'g')
      else upper(regexp_replace(p.reference_body, '[^A-Za-z0-9]', '', 'g'))
    end as normalized_reference
  from parsed p
)
select
  n.old_key,
  n.booking_ref,
  n.used_at,
  n.provider_key,
  n.provider_key || ':' || n.normalized_reference as new_key
from normalized n
where n.normalized_reference <> '';

with ranked as (
  select
    r.old_key,
    row_number() over (
      partition by r.new_key
      order by r.used_at asc, r.booking_ref asc, r.old_key asc
    ) as claim_rank
  from receipt_ref_rekey r
)
delete from public.used_gcash_refs u
using ranked r
where u.gcash_ref = r.old_key
  and r.claim_rank > 1;

update public.used_gcash_refs u
set gcash_ref = r.new_key,
    provider = r.provider_key
from receipt_ref_rekey r
where u.gcash_ref = r.old_key
  and (
    u.gcash_ref is distinct from r.new_key
    or u.provider is distinct from r.provider_key
  );

drop table receipt_ref_rekey;


-- --------------------------------------------------------------------------
-- 7. Locked attempt/rate-limit ledger
-- --------------------------------------------------------------------------

create table if not exists public.receipt_verification_attempts (
  id                       bigserial primary key,
  target_type              text not null
    check (target_type in ('booking', 'open_play')),
  target_key               text not null
    check (length(btrim(target_key)) between 1 and 160),
  attempted_at             timestamptz not null default now(),
  completed_at             timestamptz,
  outcome                  text not null default 'started'
    check (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  request_ip_hash          text,
  presented_token_hash     text,
  error_code               text,
  details                  jsonb not null default '{}'::jsonb,
  constraint receipt_attempt_ip_hash_check check (
    request_ip_hash is null or request_ip_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint receipt_attempt_token_hash_check check (
    presented_token_hash is null or presented_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint receipt_attempt_completed_at_check check (
    completed_at is null or completed_at >= attempted_at
  )
);

create index if not exists idx_receipt_attempts_target_time
  on public.receipt_verification_attempts
    (target_type, target_key, attempted_at desc);

create index if not exists idx_receipt_attempts_ip_time
  on public.receipt_verification_attempts (request_ip_hash, attempted_at desc)
  where request_ip_hash is not null;

create index if not exists idx_receipt_attempts_attempted_at
  on public.receipt_verification_attempts (attempted_at);

alter table public.receipt_verification_attempts enable row level security;
alter table public.receipt_verification_attempts force row level security;

drop policy if exists receipt_verification_attempts_no_direct_access
  on public.receipt_verification_attempts;
create policy receipt_verification_attempts_no_direct_access
on public.receipt_verification_attempts
for all
to anon, authenticated
using (false)
with check (false);

revoke all on table public.receipt_verification_attempts from public, anon, authenticated;
revoke all on sequence public.receipt_verification_attempts_id_seq from public, anon, authenticated;
grant select, insert, update on table public.receipt_verification_attempts to service_role;
grant usage, select on sequence public.receipt_verification_attempts_id_seq to service_role;


-- --------------------------------------------------------------------------
-- 8. Dashboard roles, least-privilege policies, and public read surfaces
-- --------------------------------------------------------------------------

-- Reading the caller's dashboard role through a SECURITY DEFINER helper avoids
-- recursive accounts-table RLS. A signed-in Auth user without a matching
-- public.accounts row receives NULL and gains no dashboard authority.
create or replace function public.current_dashboard_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.role
  from public.accounts a
  where a.id = auth.uid()
    and a.role in ('owner', 'court_owner', 'staff')
  limit 1
$$;

revoke all on function public.current_dashboard_role() from public;
grant execute on function public.current_dashboard_role() to authenticated;

-- BOOKINGS: all three dashboard roles operate bookings, but only the owner has
-- the client's booking_delete permission. Anonymous users read only the
-- deliberately narrow availability view below.
drop policy if exists bookings_select_public on public.bookings;
drop policy if exists bookings_select_dashboard on public.bookings;
drop policy if exists bookings_insert_authenticated on public.bookings;
drop policy if exists bookings_insert_dashboard on public.bookings;
drop policy if exists bookings_update_admin on public.bookings;
drop policy if exists bookings_update_dashboard on public.bookings;
drop policy if exists bookings_delete_admin on public.bookings;
drop policy if exists bookings_delete_owner on public.bookings;

create policy bookings_select_dashboard
on public.bookings for select to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));

create policy bookings_insert_dashboard
on public.bookings for insert to authenticated
with check (
  public.current_dashboard_role() in ('owner', 'court_owner', 'staff')
  and receipt_status <> 'manual_approved'
  and not (
    regexp_replace(lower(coalesce(payment_method, '')), '[[:space:]_-]', '', 'g')
      in ('gcash', 'gotyme', 'pnb')
    and (
      payment_status in ('paid', 'downpayment_paid')
      or status in ('confirmed', 'completed')
    )
  )
);

create policy bookings_update_dashboard
on public.bookings for update to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'))
with check (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));

create policy bookings_delete_owner
on public.bookings for delete to authenticated
using (public.current_dashboard_role() = 'owner');

revoke select, update, delete on table public.bookings from public, anon;
grant select, insert, update, delete on table public.bookings to authenticated;
grant select, insert, update, delete on table public.bookings to service_role;

create or replace view public.booking_availability
with (security_barrier = true)
as
select b.court_id, b.date, b.slots, b.status, b.created_at
from public.bookings b
where b.date >= timezone('Asia/Manila', statement_timestamp())::date
  and b.status <> 'cancelled'
  and (
    b.status <> 'verifying'
    or b.created_at is null
    or b.created_at >= statement_timestamp() - interval '15 minutes'
  );

revoke all on table public.booking_availability from public, anon, authenticated;
grant select on table public.booking_availability to anon, authenticated;

-- OPEN PLAY: all operations roles may manage registrations. Anonymous callers
-- use the count/create RPCs below and never receive registration rows.
drop policy if exists open_play_select_public on public.open_play_registrations;
drop policy if exists open_play_select_dashboard on public.open_play_registrations;
drop policy if exists open_play_insert_anon_pending on public.open_play_registrations;
drop policy if exists open_play_insert_authenticated on public.open_play_registrations;
drop policy if exists open_play_insert_dashboard on public.open_play_registrations;
drop policy if exists open_play_update_admin on public.open_play_registrations;
drop policy if exists open_play_update_dashboard on public.open_play_registrations;
drop policy if exists open_play_delete_admin on public.open_play_registrations;
drop policy if exists open_play_delete_dashboard on public.open_play_registrations;

create policy open_play_select_dashboard
on public.open_play_registrations for select to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));

create policy open_play_insert_dashboard
on public.open_play_registrations for insert to authenticated
with check (
  public.current_dashboard_role() in ('owner', 'court_owner', 'staff')
  and receipt_status <> 'manual_approved'
  and not (
    regexp_replace(lower(coalesce(payment_method, '')), '[[:space:]_-]', '', 'g')
      in ('gcash', 'gotyme', 'pnb')
    and payment_status = 'paid'
  )
);

create policy open_play_update_dashboard
on public.open_play_registrations for update to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'))
with check (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));

create policy open_play_delete_dashboard
on public.open_play_registrations for delete to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));

revoke select, insert, update, delete on table public.open_play_registrations
  from public, anon;
grant select, insert, update, delete on table public.open_play_registrations
  to authenticated;
grant select, insert, update, delete on table public.open_play_registrations
  to service_role;

-- COURTS and SETTINGS match the client's courts/settings permissions: owner and
-- court_owner can mutate; staff and unprofiled Auth users cannot.
drop policy if exists courts_insert_admin on public.courts;
drop policy if exists courts_insert_dashboard on public.courts;
drop policy if exists courts_update_admin on public.courts;
drop policy if exists courts_update_dashboard on public.courts;
drop policy if exists courts_delete_admin on public.courts;
drop policy if exists courts_delete_dashboard on public.courts;

create policy courts_insert_dashboard
on public.courts for insert to authenticated
with check (public.current_dashboard_role() in ('owner', 'court_owner'));
create policy courts_update_dashboard
on public.courts for update to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner'))
with check (public.current_dashboard_role() in ('owner', 'court_owner'));
create policy courts_delete_dashboard
on public.courts for delete to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner'));

drop policy if exists settings_insert_admin on public.settings;
drop policy if exists settings_insert_dashboard on public.settings;
drop policy if exists settings_update_admin on public.settings;
drop policy if exists settings_update_dashboard on public.settings;
drop policy if exists settings_delete_admin on public.settings;
drop policy if exists settings_delete_dashboard on public.settings;

create policy settings_insert_dashboard
on public.settings for insert to authenticated
with check (public.current_dashboard_role() in ('owner', 'court_owner'));
create policy settings_update_dashboard
on public.settings for update to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner'))
with check (public.current_dashboard_role() in ('owner', 'court_owner'));
create policy settings_delete_dashboard
on public.settings for delete to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner'));

-- Maintenance/blocked dates are available to owner and court_owner only.
drop policy if exists blocked_dates_insert_admin on public.blocked_dates;
drop policy if exists blocked_dates_insert_dashboard on public.blocked_dates;
drop policy if exists blocked_dates_delete_admin on public.blocked_dates;
drop policy if exists blocked_dates_delete_dashboard on public.blocked_dates;

create policy blocked_dates_insert_dashboard
on public.blocked_dates for insert to authenticated
with check (public.current_dashboard_role() in ('owner', 'court_owner'));
create policy blocked_dates_delete_dashboard
on public.blocked_dates for delete to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner'));

-- Every profiled user may read exactly their own account row so Auth.login can
-- construct its local session. Only owner can list everybody or mutate rows.
drop policy if exists accounts_select_admin on public.accounts;
drop policy if exists accounts_select_dashboard on public.accounts;
drop policy if exists accounts_insert_admin on public.accounts;
drop policy if exists accounts_insert_owner on public.accounts;
drop policy if exists accounts_update_admin on public.accounts;
drop policy if exists accounts_update_owner on public.accounts;
drop policy if exists accounts_delete_admin on public.accounts;
drop policy if exists accounts_delete_owner on public.accounts;

create policy accounts_select_dashboard
on public.accounts for select to authenticated
using (
  id = auth.uid()
  or public.current_dashboard_role() = 'owner'
);
create policy accounts_insert_owner
on public.accounts for insert to authenticated
with check (public.current_dashboard_role() = 'owner');
create policy accounts_update_owner
on public.accounts for update to authenticated
using (public.current_dashboard_role() = 'owner')
with check (public.current_dashboard_role() = 'owner');
create policy accounts_delete_owner
on public.accounts for delete to authenticated
using (public.current_dashboard_role() = 'owner');

-- Receipt audit data contains OCR and financial PII. Unprofiled Auth users may
-- not inherit the historical all-authenticated read policy.
drop policy if exists receipt_verifications_select_admin
  on public.receipt_verifications;
drop policy if exists receipt_verifications_select_dashboard
  on public.receipt_verifications;
create policy receipt_verifications_select_dashboard
on public.receipt_verifications for select to authenticated
using (public.current_dashboard_role() in ('owner', 'court_owner', 'staff'));


-- --------------------------------------------------------------------------
-- 9. Transactional manual receipt approval
-- --------------------------------------------------------------------------

alter table public.bookings
  drop constraint if exists bookings_receipt_status_check;
alter table public.bookings
  add constraint bookings_receipt_status_check
  check (receipt_status in (
    'none', 'auto_approved', 'manual_review', 'manual_approved', 'rejected'
  ));

alter table public.open_play_registrations
  drop constraint if exists open_play_receipt_status_check;
alter table public.open_play_registrations
  drop constraint if exists open_play_registrations_receipt_status_check;
alter table public.open_play_registrations
  add constraint open_play_receipt_status_check
  check (receipt_status in (
    'none', 'auto_approved', 'manual_review', 'manual_approved', 'rejected'
  ));

-- An OCR-screened receipt cannot be promoted or have its review state cleared
-- by a direct table update. The approval RPC sets a transaction-local guard;
-- Edge Functions use service_role and retain their existing evidence workflow.
create or replace function public.enforce_manual_receipt_approval_path()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_old_method text := regexp_replace(
    lower(btrim(coalesce(old.payment_method, ''))), '[[:space:]_-]', '', 'g'
  );
  v_new_method text := regexp_replace(
    lower(btrim(coalesce(new.payment_method, ''))), '[[:space:]_-]', '', 'g'
  );
  v_was_trusted_paid boolean := old.payment_status in ('paid', 'downpayment_paid');
begin
  if current_user = 'service_role'
     or current_setting('app.manual_receipt_approval', true) = '1'
     or current_setting('app.public_booking_finalization', true) = '1' then
    return new;
  end if;

  if new.receipt_status = 'manual_approved'
     and old.receipt_status is distinct from new.receipt_status then
    raise exception 'Use manual_approve_receipt to approve an OCR-screened receipt.'
      using errcode = '42501';
  end if;

  if old.receipt_status in ('auto_approved', 'manual_review') and (
    new.receipt_status is distinct from old.receipt_status
    or new.payment_method is distinct from old.payment_method
    or new.gcash_ref is distinct from old.gcash_ref
    or (
      new.payment_status in ('paid', 'downpayment_paid')
      and old.payment_status is distinct from new.payment_status
    )
  ) then
    raise exception 'Use manual_approve_receipt to resolve an OCR-screened receipt.'
      using errcode = '42501';
  end if;

  if old.receipt_status is distinct from new.receipt_status
     or old.receipt_image_url is distinct from new.receipt_image_url
     or old.receipt_image_hash is distinct from new.receipt_image_hash
     or old.receipt_phash is distinct from new.receipt_phash
     or old.receipt_flags is distinct from new.receipt_flags
     or old.receipt_extracted is distinct from new.receipt_extracted
     or old.receipt_confidence is distinct from new.receipt_confidence
     or old.receipt_verified_at is distinct from new.receipt_verified_at then
    raise exception 'Receipt evidence can only be changed by a trusted verification path.'
      using errcode = '42501';
  end if;

  if v_old_method in ('gcash', 'gotyme', 'pnb')
     and (
       v_new_method is distinct from v_old_method
       or new.gcash_ref is distinct from old.gcash_ref
     ) then
    raise exception 'Digital payment identity can only be changed by a trusted verification path.'
      using errcode = '42501';
  end if;

  -- Dashboard writes may manage cash normally, but may not manufacture a paid
  -- state for an offline digital receipt. Provider webhooks and the receipt
  -- verification/approval paths run as service_role or with the guard above.
  if (v_old_method in ('gcash', 'gotyme', 'pnb')
      or v_new_method in ('gcash', 'gotyme', 'pnb'))
     and not v_was_trusted_paid
     and new.payment_status in ('paid', 'downpayment_paid') then
    raise exception 'A digital payment can only be promoted by a trusted verification path.'
      using errcode = '42501';
  end if;

  -- A status-only edit must not bypass payment verification. Once a provider or
  -- trusted verification path has already marked the row paid, later operational
  -- moves (for example confirmed -> completed) remain available to dashboard users.
  if tg_table_name = 'bookings'
     and (to_jsonb(new) ->> 'status') in ('confirmed', 'completed')
     and (to_jsonb(old) ->> 'status') is distinct from (to_jsonb(new) ->> 'status')
     and not v_was_trusted_paid
     and (
       v_old_method in ('gcash', 'gotyme', 'pnb')
       or v_new_method in ('gcash', 'gotyme', 'pnb')
       or old.receipt_status in ('auto_approved', 'manual_review')
       or new.receipt_status in ('auto_approved', 'manual_review')
     ) then
    raise exception 'A digital booking must be paid by a trusted verification path before confirmation.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bookings_manual_receipt_approval
  on public.bookings;
create trigger trg_bookings_manual_receipt_approval
  before update of receipt_status, payment_status, payment_method, gcash_ref, status,
    receipt_image_url, receipt_image_hash, receipt_phash, receipt_flags,
    receipt_extracted, receipt_confidence, receipt_verified_at
  on public.bookings
  for each row execute function public.enforce_manual_receipt_approval_path();

drop trigger if exists trg_open_play_manual_receipt_approval
  on public.open_play_registrations;
create trigger trg_open_play_manual_receipt_approval
  before update of receipt_status, payment_status, payment_method, gcash_ref,
    receipt_image_url, receipt_image_hash, receipt_phash, receipt_flags,
    receipt_extracted, receipt_confidence, receipt_verified_at
  on public.open_play_registrations
  for each row execute function public.enforce_manual_receipt_approval_path();

create or replace function public.manual_approve_receipt(
  p_target_type text,
  p_target_key text,
  p_provider text,
  p_payment_reference text
)
returns table (
  target_type text,
  target_key text,
  payment_status text,
  booking_status text,
  receipt_status text,
  provider text,
  normalized_reference text,
  ledger_key text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := public.current_dashboard_role();
  v_actor uuid := auth.uid();
  v_now timestamptz := statement_timestamp();
  v_target_type text := lower(btrim(coalesce(p_target_type, '')));
  v_target_key text := btrim(coalesce(p_target_key, ''));
  v_provider text := regexp_replace(
    lower(btrim(coalesce(p_provider, ''))), '[[:space:]_-]', '', 'g'
  );
  v_reference text;
  v_ledger_key text;
  v_owner_key text;
  v_claim_owner text;
  v_payment_status text;
  v_booking_status text;
  v_audit_extracted jsonb;
  v_already_approved boolean := false;
  v_booking public.bookings%rowtype;
  v_open_play public.open_play_registrations%rowtype;
  v_open_play_id bigint;
begin
  if v_role not in ('owner', 'court_owner', 'staff') then
    raise exception 'A dashboard payments role is required.' using errcode = '42501';
  end if;

  if v_target_type in ('openplay', 'open-play') then
    v_target_type := 'open_play';
  end if;
  if v_target_type not in ('booking', 'open_play') or v_target_key = '' then
    raise exception 'target_type and target_key are invalid.' using errcode = '22023';
  end if;
  if v_provider not in ('gcash', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment provider.' using errcode = '22023';
  end if;

  if v_provider = 'gcash' then
    v_reference := regexp_replace(
      coalesce(p_payment_reference, ''), '[^0-9]', '', 'g'
    );
    if v_reference !~ '^[0-9]{13}$' then
      raise exception 'GCash reference must contain exactly 13 digits.'
        using errcode = '22023';
    end if;
  else
    v_reference := upper(regexp_replace(
      coalesce(p_payment_reference, ''), '[^A-Za-z0-9]', '', 'g'
    ));
    if v_reference !~ '^[A-Z0-9]{6,40}$' then
      raise exception 'Bank reference must contain 6 to 40 letters or digits.'
        using errcode = '22023';
    end if;
  end if;
  v_ledger_key := v_provider || ':' || v_reference;

  if v_target_type = 'booking' then
    select b.* into v_booking
    from public.bookings b
    where b.ref = v_target_key
    for update;
    if not found then
      raise exception 'Booking receipt target was not found.' using errcode = 'P0002';
    end if;
    if v_booking.receipt_image_url is null or v_booking.receipt_image_hash is null then
      raise exception 'Stored receipt evidence is required before approval.'
        using errcode = '22023';
    end if;
    if v_booking.receipt_status = 'manual_approved' then
      v_already_approved := true;
      if regexp_replace(lower(coalesce(v_booking.payment_method, '')), '[[:space:]_-]', '', 'g')
           is distinct from v_provider
         or (
           case when v_provider = 'gcash'
             then regexp_replace(coalesce(v_booking.gcash_ref, ''), '[^0-9]', '', 'g')
             else upper(regexp_replace(coalesce(v_booking.gcash_ref, ''), '[^A-Za-z0-9]', '', 'g'))
           end
         ) is distinct from v_reference then
        raise exception 'Receipt is already approved under another payment reference.'
          using errcode = '22023';
      end if;
    elsif v_booking.receipt_status not in ('auto_approved', 'manual_review') then
      raise exception 'Only an OCR-screened receipt can be manually approved.'
        using errcode = '22023';
    end if;
    if v_booking.status = 'cancelled' then
      raise exception 'A cancelled booking cannot be approved.' using errcode = '22023';
    end if;
    v_owner_key := 'BK:' || v_booking.ref;
    v_payment_status := case
      when coalesce(v_booking.downpayment, 0) >= coalesce(v_booking.total, 0) - 0.01
        then 'paid'
      else 'downpayment_paid'
    end;
    v_booking_status := case
      when v_booking.status = 'completed' then 'completed'
      else 'confirmed'
    end;
  else
    if v_target_key !~ '^[0-9]+$' then
      raise exception 'Open Play target key must be a registration id.'
        using errcode = '22023';
    end if;
    v_open_play_id := v_target_key::bigint;
    select r.* into v_open_play
    from public.open_play_registrations r
    where r.id = v_open_play_id
    for update;
    if not found then
      raise exception 'Open Play receipt target was not found.' using errcode = 'P0002';
    end if;
    if v_open_play.receipt_image_url is null or v_open_play.receipt_image_hash is null then
      raise exception 'Stored receipt evidence is required before approval.'
        using errcode = '22023';
    end if;
    if v_open_play.receipt_status = 'manual_approved' then
      v_already_approved := true;
      if regexp_replace(lower(coalesce(v_open_play.payment_method, '')), '[[:space:]_-]', '', 'g')
           is distinct from v_provider
         or (
           case when v_provider = 'gcash'
             then regexp_replace(coalesce(v_open_play.gcash_ref, ''), '[^0-9]', '', 'g')
             else upper(regexp_replace(coalesce(v_open_play.gcash_ref, ''), '[^A-Za-z0-9]', '', 'g'))
           end
         ) is distinct from v_reference then
        raise exception 'Receipt is already approved under another payment reference.'
          using errcode = '22023';
      end if;
    elsif v_open_play.receipt_status not in ('auto_approved', 'manual_review') then
      raise exception 'Only an OCR-screened receipt can be manually approved.'
        using errcode = '22023';
    end if;
    v_owner_key := 'OP:' || v_open_play.id::text;
    v_payment_status := 'paid';
    v_booking_status := null;
  end if;

  -- The primary key is the concurrency authority. ON CONFLICT waits for a
  -- concurrent claimant; the locked read then distinguishes retry from replay.
  insert into public.used_gcash_refs (gcash_ref, booking_ref, provider)
  values (v_ledger_key, v_owner_key, v_provider)
  on conflict (gcash_ref) do nothing
  returning booking_ref into v_claim_owner;

  if v_claim_owner is null then
    select u.booking_ref into v_claim_owner
    from public.used_gcash_refs u
    where u.gcash_ref = v_ledger_key
    for update;
    if v_claim_owner is distinct from v_owner_key
       and not (v_target_type = 'booking' and v_claim_owner = v_target_key) then
      raise exception 'Payment reference is already claimed by another target.'
        using errcode = '23505';
    end if;
    update public.used_gcash_refs
    set booking_ref = v_owner_key, provider = v_provider
    where gcash_ref = v_ledger_key;
  end if;

  if not v_already_approved then
    perform set_config('app.manual_receipt_approval', '1', true);

    if v_target_type = 'booking' then
      v_audit_extracted := coalesce(v_booking.receipt_extracted, '{}'::jsonb)
        || jsonb_build_object('manualApproval', jsonb_build_object(
          'approvedBy', v_actor::text,
          'role', v_role,
          'approvedAt', v_now,
          'provider', v_provider,
          'reference', v_reference
        ));
      update public.bookings
      set payment_method = v_provider,
          gcash_ref = v_reference,
          payment_status = v_payment_status,
          status = v_booking_status,
          paid_at = coalesce(paid_at, v_now),
          receipt_status = 'manual_approved',
          receipt_extracted = v_audit_extracted,
          receipt_verified_at = v_now
      where ref = v_booking.ref;

      insert into public.receipt_verifications (
        booking_ref, result, flags, extracted, confidence,
        image_hash, phash, raw_ocr_text
      ) values (
        v_owner_key, 'manual_approved', v_booking.receipt_flags,
        v_audit_extracted, v_booking.receipt_confidence,
        v_booking.receipt_image_hash, v_booking.receipt_phash, null
      );
    else
      v_audit_extracted := coalesce(v_open_play.receipt_extracted, '{}'::jsonb)
        || jsonb_build_object('manualApproval', jsonb_build_object(
          'approvedBy', v_actor::text,
          'role', v_role,
          'approvedAt', v_now,
          'provider', v_provider,
          'reference', v_reference
        ));
      update public.open_play_registrations
      set payment_method = v_provider,
          gcash_ref = v_reference,
          payment_status = 'paid',
          receipt_status = 'manual_approved',
          receipt_extracted = v_audit_extracted,
          receipt_verified_at = v_now
      where id = v_open_play.id;

      insert into public.receipt_verifications (
        booking_ref, result, flags, extracted, confidence,
        image_hash, phash, raw_ocr_text
      ) values (
        v_owner_key, 'manual_approved', v_open_play.receipt_flags,
        v_audit_extracted, v_open_play.receipt_confidence,
        v_open_play.receipt_image_hash, v_open_play.receipt_phash, null
      );
    end if;
  end if;

  return query select
    v_target_type, v_target_key, v_payment_status, v_booking_status,
    'manual_approved'::text, v_provider, v_reference, v_ledger_key;
end;
$$;

revoke all on function public.manual_approve_receipt(text, text, text, text)
  from public;
grant execute on function public.manual_approve_receipt(text, text, text, text)
  to authenticated;


-- --------------------------------------------------------------------------
-- 10. Public Open Play count and authoritative registration creation
-- --------------------------------------------------------------------------

create or replace function public.get_public_open_play_count(
  p_date date,
  p_court_id text default null,
  p_session_key text default null,
  p_session_start integer default null
)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::bigint
  from public.open_play_registrations r
  where r.date = p_date
    and (r.payment_status is null or r.payment_status <> 'rejected')
    and (
      r.payment_method = 'cash'
      or r.receipt_upload_token_used_at is not null
      or r.receipt_upload_token_expires_at > statement_timestamp()
    )
    and (p_court_id is null or r.court_id = p_court_id)
    and (p_session_start is null or r.hour = p_session_start)
    and (
      p_session_start is not null
      or p_session_key is null
      or r.session_key = p_session_key
    )
$$;

revoke all on function public.get_public_open_play_count(date, text, text, integer)
  from public;
grant execute on function public.get_public_open_play_count(date, text, text, integer)
  to anon, authenticated;

create or replace function public.create_public_open_play_registration(
  p_full_name text,
  p_court_id text,
  p_date date,
  p_session_key text,
  p_payment_type text,
  p_payment_method text,
  p_payment_reference text default null,
  p_receipt_upload_token_hash text default null
)
returns table (
  registration_id bigint,
  session_key text,
  session_start integer,
  session_end integer,
  base_fee numeric,
  system_fee numeric,
  total_due numeric,
  amount_due numeric,
  payment_status text,
  receipt_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_config_text text;
  v_config jsonb;
  v_sessions jsonb;
  v_candidate jsonb;
  v_candidate_start numeric;
  v_candidate_end numeric;
  v_candidate_key text;
  v_candidate_fee numeric;
  v_candidate_max integer;
  v_session_key text;
  v_session_name text;
  v_session_start integer;
  v_session_end integer;
  v_base_fee numeric;
  v_max_players integer;
  v_system_fee numeric;
  v_total_due numeric;
  v_amount_due numeric;
  v_fee_text text;
  v_acceptance_mode text;
  v_payment_type text := lower(btrim(coalesce(p_payment_type, '')));
  v_method text := regexp_replace(
    lower(btrim(coalesce(p_payment_method, ''))), '[[:space:]_-]', '', 'g'
  );
  v_reference text;
  v_method_enabled text;
  v_court_id text := btrim(coalesce(p_court_id, ''));
  v_court_name text;
  v_date_allowed boolean := false;
  v_court_allowed boolean := true;
  v_current_count bigint;
  v_registration_id bigint;
begin
  if length(btrim(coalesce(p_full_name, ''))) not between 2 and 150
     or p_full_name ~ '[[:cntrl:]<>]' then
    raise exception 'Full name must be between 2 and 150 characters.'
      using errcode = '22023';
  end if;
  if v_court_id = '' or p_date is null or btrim(coalesce(p_session_key, '')) = '' then
    raise exception 'Court, date, and session key are required.' using errcode = '22023';
  end if;
  if p_date < timezone('Asia/Manila', v_now)::date then
    raise exception 'Open Play date has already passed.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.blocked_dates b where b.date = p_date
  ) then
    raise exception 'Open Play is closed on this date.' using errcode = '22023';
  end if;

  select s.value into v_config_text
  from public.settings s where s.key = 'open_play_config';
  if v_config_text is null then
    raise exception 'Open Play configuration is missing.' using errcode = '22023';
  end if;
  begin
    v_config := v_config_text::jsonb;
  exception when others then
    raise exception 'Open Play configuration is invalid JSON.' using errcode = '22023';
  end;
  if jsonb_typeof(v_config) <> 'object'
     or lower(coalesce(v_config->>'enabled', 'false')) not in ('true', '1', 'yes', 'on') then
    raise exception 'Open Play is disabled.' using errcode = '22023';
  end if;

  select exists (
    select 1
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_config->'specificDates') = 'array'
        then v_config->'specificDates' else '[]'::jsonb end
    ) d(value)
    where d.value = p_date::text
  ) or exists (
    select 1
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_config->'days') = 'array'
        then v_config->'days' else '[]'::jsonb end
    ) d(value)
    where d.value ~ '^[0-6]$'
      and d.value::integer = extract(dow from p_date)::integer
  ) into v_date_allowed;
  if not v_date_allowed then
    raise exception 'Date is not configured for Open Play.' using errcode = '22023';
  end if;

  select c.name into v_court_name
  from public.courts c
  where c.id = v_court_id and not c.blocked;
  if not found then
    raise exception 'Court is unavailable.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_config->'courtIds') = 'array'
     and jsonb_array_length(v_config->'courtIds') > 0 then
    select exists (
      select 1 from jsonb_array_elements_text(v_config->'courtIds') c(value)
      where c.value = v_court_id
    ) into v_court_allowed;
  end if;
  if not v_court_allowed then
    raise exception 'Court is not configured for Open Play.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_config->'sessions') = 'array'
     and jsonb_array_length(v_config->'sessions') > 0 then
    v_sessions := v_config->'sessions';
  else
    v_sessions := jsonb_build_array(jsonb_build_object(
      'start', v_config->'start',
      'end', v_config->'end',
      'fee', coalesce(v_config->'fee', '100'::jsonb),
      'maxPlayers', coalesce(v_config->'maxPlayers', '40'::jsonb)
    ));
  end if;

  for v_candidate in
    select value from jsonb_array_elements(v_sessions)
  loop
    begin
      v_candidate_start := (v_candidate->>'start')::numeric;
      v_candidate_end := (v_candidate->>'end')::numeric;
      v_candidate_fee := coalesce(
        nullif(v_candidate->>'fee', ''), nullif(v_config->>'fee', ''), '100'
      )::numeric;
      v_candidate_max := coalesce(
        nullif(v_candidate->>'maxPlayers', ''),
        nullif(v_config->>'maxPlayers', ''), '40'
      )::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      continue;
    end;
    if v_candidate_start::text in ('NaN', 'Infinity', '-Infinity')
       or v_candidate_end::text in ('NaN', 'Infinity', '-Infinity')
       or v_candidate_fee::text in ('NaN', 'Infinity', '-Infinity')
       or v_candidate_start <> trunc(v_candidate_start)
       or v_candidate_end <> trunc(v_candidate_end)
       or v_candidate_start < 0 or v_candidate_end > 24
       or v_candidate_end <= v_candidate_start
       or v_candidate_fee < 0
       or v_candidate_max < 1 or v_candidate_max > 1000 then
      continue;
    end if;
    v_candidate_key := coalesce(
      nullif(btrim(v_candidate->>'key'), ''),
      nullif(btrim(v_candidate->>'id'), ''),
      'op-' || trunc(v_candidate_start)::text || '-' || trunc(v_candidate_end)::text
    );
    if v_candidate_key = btrim(p_session_key) then
      v_session_key := v_candidate_key;
      v_session_name := coalesce(
        nullif(btrim(v_candidate->>'name'), ''), 'Open Play'
      );
      v_session_start := v_candidate_start::integer;
      v_session_end := v_candidate_end::integer;
      v_base_fee := round(v_candidate_fee, 2);
      v_max_players := v_candidate_max;
      exit;
    end if;
  end loop;
  if v_session_key is null then
    raise exception 'Session is not configured for Open Play.' using errcode = '22023';
  end if;
  if p_date::timestamp + make_interval(hours => v_session_end)
       <= timezone('Asia/Manila', v_now) then
    raise exception 'Open Play session has already ended.' using errcode = '22023';
  end if;

  select s.value into v_fee_text from public.settings s
  where s.key = 'maintenance_fee';
  if not found then
    select s.value into v_fee_text from public.settings s
    where s.key = 'service_fee_rate';
  end if;
  if not found then
    select s.value into v_fee_text from public.settings s
    where s.key = 'booking_fee';
  end if;
  begin
    v_system_fee := round(coalesce(nullif(btrim(v_fee_text), ''), '0')::numeric, 2);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Open Play system fee is invalid.' using errcode = '22023';
  end;
  if v_system_fee::text in ('NaN', 'Infinity', '-Infinity') or v_system_fee < 0 then
    raise exception 'Open Play system fee is invalid.' using errcode = '22023';
  end if;
  v_total_due := round(v_base_fee + v_system_fee, 2);

  select lower(btrim(s.value)) into v_acceptance_mode
  from public.settings s where s.key = 'payment_acceptance_mode';
  v_acceptance_mode := coalesce(v_acceptance_mode, 'both');
  if v_payment_type in ('100%', 'full', 'full_payment', 'fullpayment') then
    v_payment_type := '100%';
    v_amount_due := v_total_due;
    if v_acceptance_mode = 'downpayment_only' then
      raise exception 'Only a 50%% downpayment is currently accepted.' using errcode = '22023';
    end if;
  elsif v_payment_type in ('50%', 'half', 'downpayment', 'downpayment_only') then
    v_payment_type := '50%';
    v_amount_due := round(v_total_due / 2, 2);
    if v_acceptance_mode = 'full_payment_only' then
      raise exception 'Full payment is currently required.' using errcode = '22023';
    end if;
  else
    raise exception 'Payment type must be 50%% or 100%%.' using errcode = '22023';
  end if;

  if v_method not in ('cash', 'gcash', 'gotyme', 'pnb') then
    raise exception 'Unsupported payment method.' using errcode = '22023';
  end if;
  if length(coalesce(p_payment_reference, '')) > 100 then
    raise exception 'Payment reference is too long.' using errcode = '22023';
  end if;
  select lower(btrim(s.value)) into v_method_enabled
  from public.settings s where s.key = 'payment_method_' || v_method;
  if coalesce(v_method_enabled, '0') not in ('1', 'true', 'yes', 'on') then
    raise exception 'Selected payment method is disabled.' using errcode = '22023';
  end if;

  if v_method = 'cash' then
    if nullif(btrim(coalesce(p_payment_reference, '')), '') is not null
       or nullif(btrim(coalesce(p_receipt_upload_token_hash, '')), '') is not null then
      raise exception 'Cash registration must not contain receipt credentials.'
        using errcode = '22023';
    end if;
    v_reference := null;
  elsif v_method = 'gcash' then
    v_reference := regexp_replace(
      coalesce(p_payment_reference, ''), '[^0-9]', '', 'g'
    );
    if v_reference !~ '^[0-9]{13}$' then
      raise exception 'GCash reference must contain exactly 13 digits.'
        using errcode = '22023';
    end if;
  else
    v_reference := upper(regexp_replace(
      coalesce(p_payment_reference, ''), '[^A-Za-z0-9]', '', 'g'
    ));
    if v_reference !~ '^[A-Z0-9]{6,40}$' then
      raise exception 'Bank reference must contain 6 to 40 letters or digits.'
        using errcode = '22023';
    end if;
  end if;
  if v_method <> 'cash'
     and coalesce(p_receipt_upload_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Digital payment requires a valid receipt token hash.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'open-play:' || p_date::text || ':' || v_court_id || ':' || v_session_start::text,
    0
  ));
  select count(*)::bigint into v_current_count
  from public.open_play_registrations r
  where r.date = p_date
    and r.court_id = v_court_id
    and r.hour = v_session_start
    and (r.payment_status is null or r.payment_status <> 'rejected')
    and (
      r.payment_method = 'cash'
      or r.receipt_upload_token_used_at is not null
      or r.receipt_upload_token_expires_at > v_now
    );
  if v_current_count >= v_max_players then
    raise exception 'Open Play session is full.' using errcode = 'P0001';
  end if;

  insert into public.open_play_registrations (
    full_name, court_id, court_name, date, hour, time_label,
    session_key, session_start, session_end,
    base_fee, system_fee, total_due,
    payment_type, payment_method, gcash_ref, payment_status, amount,
    receipt_status, receipt_upload_token_hash, created_at
  ) values (
    btrim(p_full_name), v_court_id, v_court_name, p_date, v_session_start,
    v_session_name || ' · ' || v_session_start::text || ':00–' || v_session_end::text || ':00',
    v_session_key, v_session_start, v_session_end,
    v_base_fee, v_system_fee, v_total_due,
    v_payment_type, v_method, v_reference, 'pending', v_amount_due,
    'none', case when v_method = 'cash' then null else p_receipt_upload_token_hash end,
    v_now
  ) returning id into v_registration_id;

  return query select
    v_registration_id, v_session_key, v_session_start, v_session_end,
    v_base_fee, v_system_fee, v_total_due, v_amount_due,
    'pending'::text, 'none'::text;
end;
$$;

revoke all on function public.create_public_open_play_registration(
  text, text, date, text, text, text, text, text
) from public;
grant execute on function public.create_public_open_play_registration(
  text, text, date, text, text, text, text, text
) to anon, authenticated;


-- Reload PostgREST so the new columns and capability RPCs are immediately
-- visible to supabase-js after this migration is applied.
notify pgrst, 'reload schema';
