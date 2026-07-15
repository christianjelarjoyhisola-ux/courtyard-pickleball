begin;

-- Public bookings begin as tightly constrained placeholder holds. The existing
-- bookings_insert_anon_hold RLS policy validates every field; this table-level
-- privilege is also required before PostgreSQL will evaluate that policy.
grant insert on table public.bookings to anon;

-- Conflict detection must see all active holds even though anonymous callers
-- cannot read customer booking rows. Run this trigger function as its owner
-- instead of granting broad SELECT access to anon.
alter function public.prevent_double_booking() security definer;

notify pgrst, 'reload schema';

commit;
