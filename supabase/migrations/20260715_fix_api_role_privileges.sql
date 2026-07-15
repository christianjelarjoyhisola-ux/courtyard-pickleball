-- Restore the PostgreSQL privileges required by the app's RLS policies.
--
-- RLS policies decide which rows each caller may access, but callers also need
-- table-level privileges before PostgREST can evaluate those policies. The
-- fresh-project bootstrap created the policies without granting these base
-- privileges, which caused 401 "permission denied for table" responses.

begin;

grant usage on schema public to anon, authenticated, service_role;

-- Public booking-page reference data. RLS keeps writes restricted to the
-- authenticated dashboard roles defined in current_dashboard_role().
grant select on table
  public.courts,
  public.settings,
  public.blocked_dates
to anon, authenticated;

grant insert, update, delete on table
  public.courts,
  public.settings
to authenticated;

grant insert, delete on table public.blocked_dates to authenticated;

-- Authenticated dashboard data. Existing RLS policies continue to enforce the
-- owner/court_owner/staff permission matrix and per-user agreement access.
grant select, insert, update, delete on table
  public.accounts,
  public.agreements,
  public.bookings,
  public.open_play_registrations,
  public.weekly_fees
to authenticated;

grant select on table public.receipt_verifications to authenticated;

-- Edge Functions use service_role for trusted payment and receipt workflows.
grant select, insert, update, delete on table
  public.accounts,
  public.agreements,
  public.blocked_dates,
  public.bookings,
  public.courts,
  public.open_play_registrations,
  public.payment_sessions,
  public.receipt_verification_attempts,
  public.receipt_verifications,
  public.settings,
  public.used_gcash_refs,
  public.weekly_fees
to service_role;

-- Identity/serial-backed inserts need access to their generated sequences.
grant usage, select on sequence
  public.open_play_registrations_id_seq,
  public.receipt_verification_attempts_id_seq,
  public.receipt_verifications_id_seq
to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
