begin;

create or replace function public.auto_approve_gcash_receipt(
  p_target_type text,
  p_target_key text,
  p_payment_reference text,
  p_image_hash text
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
  v_now timestamptz := statement_timestamp();
  v_target_type text := lower(btrim(coalesce(p_target_type, '')));
  v_target_key text := btrim(coalesce(p_target_key, ''));
  v_reference text := regexp_replace(
    coalesce(p_payment_reference, ''), '[^0-9]', '', 'g'
  );
  v_image_hash text := lower(btrim(coalesce(p_image_hash, '')));
  v_ledger_key text;
  v_owner_key text;
  v_claim_owner text;
  v_payment_status text;
  v_booking_status text;
  v_extracted jsonb;
  v_booking public.bookings%rowtype;
  v_open_play public.open_play_registrations%rowtype;
  v_open_play_id bigint;
begin
  if v_target_type in ('openplay', 'open-play') then
    v_target_type := 'open_play';
  end if;
  if v_target_type not in ('booking', 'open_play') or v_target_key = '' then
    raise exception 'target_type and target_key are invalid.' using errcode = '22023';
  end if;
  if v_reference !~ '^[0-9]{13}$' then
    raise exception 'GCash reference must contain exactly 13 digits.'
      using errcode = '22023';
  end if;
  if v_image_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid receipt image hash is required.' using errcode = '22023';
  end if;
  v_ledger_key := 'gcash:' || v_reference;

  if v_target_type = 'booking' then
    select b.* into v_booking
    from public.bookings b
    where b.ref = v_target_key
    for update;
    if not found then
      raise exception 'Booking receipt target was not found.' using errcode = 'P0002';
    end if;
    if regexp_replace(lower(coalesce(v_booking.payment_method, '')), '[[:space:]_-]', '', 'g') <> 'gcash'
       or regexp_replace(coalesce(v_booking.gcash_ref, ''), '[^0-9]', '', 'g') <> v_reference then
      raise exception 'Booking GCash details do not match the verified receipt.'
        using errcode = '22023';
    end if;
    if v_booking.receipt_status <> 'auto_approved'
       or cardinality(coalesce(v_booking.receipt_flags, '{}'::text[])) <> 0
       or v_booking.receipt_image_hash is distinct from v_image_hash
       or coalesce(v_booking.receipt_confidence, 0) < 0.85
       or coalesce(v_booking.receipt_extracted->>'provider', '') <> 'gcash'
       or regexp_replace(coalesce(v_booking.receipt_extracted->>'ref', ''), '[^0-9]', '', 'g') <> v_reference
       or coalesce(v_booking.receipt_extracted->>'amountReliable', 'false') <> 'true'
       or coalesce(v_booking.receipt_extracted->>'recipientNumberStatus', '') <> 'match'
       or coalesce(v_booking.receipt_extracted->>'date', '') = ''
       or coalesce(v_booking.receipt_extracted->>'time', '') = '' then
      raise exception 'Receipt has not passed every automatic GCash check.'
        using errcode = '22023';
    end if;
    if v_booking.status = 'cancelled' or v_booking.payment_status = 'rejected' then
      raise exception 'A cancelled or rejected booking cannot be approved.'
        using errcode = '22023';
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
    v_extracted := coalesce(v_booking.receipt_extracted, '{}'::jsonb);
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
    if regexp_replace(lower(coalesce(v_open_play.payment_method, '')), '[[:space:]_-]', '', 'g') <> 'gcash'
       or regexp_replace(coalesce(v_open_play.gcash_ref, ''), '[^0-9]', '', 'g') <> v_reference then
      raise exception 'Open Play GCash details do not match the verified receipt.'
        using errcode = '22023';
    end if;
    if v_open_play.receipt_status <> 'auto_approved'
       or cardinality(coalesce(v_open_play.receipt_flags, '{}'::text[])) <> 0
       or v_open_play.receipt_image_hash is distinct from v_image_hash
       or coalesce(v_open_play.receipt_confidence, 0) < 0.85
       or coalesce(v_open_play.receipt_extracted->>'provider', '') <> 'gcash'
       or regexp_replace(coalesce(v_open_play.receipt_extracted->>'ref', ''), '[^0-9]', '', 'g') <> v_reference
       or coalesce(v_open_play.receipt_extracted->>'amountReliable', 'false') <> 'true'
       or coalesce(v_open_play.receipt_extracted->>'recipientNumberStatus', '') <> 'match'
       or coalesce(v_open_play.receipt_extracted->>'date', '') = ''
       or coalesce(v_open_play.receipt_extracted->>'time', '') = '' then
      raise exception 'Receipt has not passed every automatic GCash check.'
        using errcode = '22023';
    end if;
    if v_open_play.payment_status = 'rejected' then
      raise exception 'A rejected registration cannot be approved.' using errcode = '22023';
    end if;
    v_owner_key := 'OP:' || v_open_play.id::text;
    v_payment_status := 'paid';
    v_booking_status := null;
    v_extracted := coalesce(v_open_play.receipt_extracted, '{}'::jsonb);
  end if;

  insert into public.used_gcash_refs (gcash_ref, booking_ref, provider)
  values (v_ledger_key, v_owner_key, 'gcash')
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
    set booking_ref = v_owner_key, provider = 'gcash'
    where gcash_ref = v_ledger_key;
  end if;

  perform set_config('app.manual_receipt_approval', '1', true);
  v_extracted := v_extracted || jsonb_build_object('autoApproval', jsonb_build_object(
    'approvedAt', v_now,
    'provider', 'gcash',
    'reference', v_reference,
    'rule', 'strict_zero_flags_v1'
  ));

  if v_target_type = 'booking' then
    update public.bookings
    set payment_status = v_payment_status,
        status = v_booking_status,
        paid_at = coalesce(paid_at, v_now),
        receipt_extracted = v_extracted,
        receipt_verified_at = v_now
    where ref = v_booking.ref;
  else
    update public.open_play_registrations
    set payment_status = 'paid',
        receipt_extracted = v_extracted,
        receipt_verified_at = v_now
    where id = v_open_play.id;
  end if;

  return query select
    v_target_type, v_target_key, v_payment_status, v_booking_status,
    'auto_approved'::text, 'gcash'::text, v_reference, v_ledger_key;
end;
$$;

revoke all on function public.auto_approve_gcash_receipt(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.auto_approve_gcash_receipt(text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
