-- Allow repeated receipt screenshots. Verification now relies on payment
-- details, especially the transaction/reference ledger, not image similarity.
drop index if exists public.uniq_bookings_receipt_phash;
