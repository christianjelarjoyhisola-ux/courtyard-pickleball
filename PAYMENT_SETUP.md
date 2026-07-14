# Secure GCash Payment Setup (Dynamic Amount + Auto Sync)

This project now supports:
- Dynamic downpayment amount from booking form
- Server-created payment session (no raw gateway URL logic in browser)
- Webhook-based auto update of booking payment status

## 1) Run DB Migration

Apply:

`supabase/migrations/20260227_payment_security.sql`

It adds:
- New payment columns on `bookings`
- `payment_sessions` table for checkout tracking

## 2) Deploy Supabase Edge Functions

Deploy:
- `supabase/functions/create-payment-session`
- `supabase/functions/payment-webhook`

Example:

```bash
supabase functions deploy create-payment-session
supabase functions deploy payment-webhook
```

## 3) Set Function Environment Variables

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAYMENT_PROVIDER`

Recommended (dynamic amount with PayMongo):
- `PAYMENT_PROVIDER=paymongo`
- `PAYMONGO_SECRET_KEY=sk_live_...` (or `sk_test_...`)
- `PAYMENT_SUCCESS_URL=https://your-domain/success`
- `PAYMENT_CANCEL_URL=https://your-domain/cancel`

Template fallback mode (legacy/static-link style):
- `PAYMENT_PROVIDER=template`
- `PAYMENT_CHECKOUT_URL_TEMPLATE=https://your-gateway-link?...`

Optional security:
- `PAYMENT_WEBHOOK_SECRET` (used by `payment-webhook` via `x-payment-signature` HMAC SHA-256)

## 4) Configure Gateway Webhook

Point your gateway webhook to:

`https://<project-ref>.functions.supabase.co/payment-webhook`

Send payload fields:
- `session_id` (preferred) or `booking_ref`
- `status` (`paid`, `failed`, etc.)
- `provider_reference` (optional)
- `paid_at` (optional)

## 5) Configure App Admin Settings

In Admin panel:
- Go to `Courts` -> `GCash Payment Settings`
- Enable checkout mode
- Set merchant name and number
- Save

The booking page will:
- Save booking
- Create secure payment session
- Open checkout URL returned by function
- Auto-sync payment status and confirm booking when webhook marks paid

## PayMongo-specific notes

- The function now creates a **new PayMongo Checkout Session per booking**, so amount is dynamic.
- Webhook handler supports PayMongo event payload parsing and maps provider session IDs back to your booking.

## 6) Security Notes

- Keep provider secrets only in Edge Function env vars.
- Do not expose service-role keys in frontend.
- Keep `payment_sessions` RLS locked (already included in migration).
- Use webhook signature validation (`PAYMENT_WEBHOOK_SECRET`) in production.

## 7) Receipt OCR Screening (Not Payment Confirmation)

Deploy this feature in this order so the public client never runs against the
old permissive policies. For a **fresh Courtyard project**, select and verify
that project in the Supabase SQL editor, then run only these files in order:

1. `SETUP_NEW_SUPABASE.sql` (this already embeds the secure receipt changes from
   `20260713_secure_receipt_verification.sql`).
2. `supabase/migrations/20260613_agreements.sql`.
3. `supabase/migrations/20260613_weekly_billing.sql`.
4. `supabase/migrations/20260614_billing_audit.sql`.
5. `supabase/migrations/20260714_fix_agreements_weekly_fees_rls.sql`.

Do **not** run `supabase db push` for this bootstrap. This repository contains
historical migrations that are not all safe to replay after the one-shot setup
script, and `db push` may target whichever project the CLI is currently linked
to. For an existing Courtyard database, apply only the specifically reviewed,
unapplied migration files; apply `20260713_secure_receipt_verification.sql`
before `20260714_fix_agreements_weekly_fees_rls.sql`.

After the SQL is complete, deploy the function to the explicitly named
Courtyard project, then deploy the updated `supabase-config.js` and `index.html`:

```bash
supabase functions deploy verify-gcash-receipt --project-ref <COURTYARD_PROJECT_REF>
```

Set these Edge Function secrets:

- `GOOGLE_VISION_API_KEY` — primary OCR provider. Restrict the key to the
  Vision API and configure a billing quota.
- `OCRSPACE_API_KEY` — optional fallback. Do not use a public/demo key.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — these
  are normally supplied by Supabase; the service-role key must never be placed
  in browser code.
- `RECEIPT_VERIFY_MAX_ATTEMPTS` — optional, defaults to 5 attempts per target
  in 15 minutes (maximum 20).
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` — optional review alerts.

For each enabled provider (`gcash`, `gotyme`, or `pnb`), configure the matching
`<provider>_merchant_number` and `<provider>_merchant_name` settings. Missing
merchant data, an OCR outage, unreadable fields, low confidence, pricing
disagreement, a reference/amount/recipient mismatch, or any other uncertainty
goes to manual review.

### Safety and decision semantics

OCR is a receipt-screening aid, not proof that money settled in the merchant
account. The machine result named `auto_approved` means only that the uploaded
document passed the configured OCR checks. A clean screening result must leave
the booking or Open Play registration pending (`for_verification` where that
status applies) until the owner checks the actual GCash, GoTyme, or PNB account.
The customer UI must not call an OCR-screened receipt paid or confirmed.

The only safe automatic rejection is provider-reference replay that is proven
by the database: an atomic lookup must show that the same normalized,
provider-scoped reference was previously claimed in the reference ledger by a
different payment target.
OCR screening only reads this ledger; it never reserves a reference. The
authenticated manual-confirmation transaction is the sole path that creates a
new claim and marks the target paid/confirmed.
OCR text alone must not cause automatic rejection. Reference mismatches, low or
unreadable amounts, recipient mismatches, date/time issues, image-quality
problems, provider outages, and all other uncertain or contradictory results
must route to owner review with the receipt evidence preserved.

### Capability-bound, evidence-first upload flow

1. The browser creates a cryptographically random, one-time receipt capability.
   Only its SHA-256 hash is stored with the new booking hold or pending Open Play
   registration; the raw token remains in that browser session until a terminal
   result consumes it.
2. The payment target is persisted before OCR starts. A public booking begins as
   a non-PII slot hold; capability-authorized finalization rebuilds its schedule
   and payable amount from database rates, fees, and settings, so the browser's
   price snapshot is never authoritative.
3. The upload identifies that exact target and sends the raw capability with the
   receipt image. The Edge Function validates that the target is finalized, then
   checks the capability, expiry, and rate limit before doing any OCR work.
4. The submitted receipt evidence is written to the private `receipts` bucket
   first. A durable database checkpoint attaches that object to the target and
   consumes the one-time capability before OCR or later decision logic runs.
5. If OCR or a downstream service fails after that checkpoint, the evidence and
   pending/manual-review state remain available to the owner. A browser timeout
   is treated as uncertain: keep the screenshot, do not pay again, and do not
   overwrite a result that may already have committed.

The receipt migrations create the private bucket, one-time 15-minute upload
capabilities, server-derived pricing checks, provider-scoped reference replay
protection, and restricted signed receipt viewing for dashboard roles.

### Recommended phase 2: provider confirmation

Use a provider webhook or authenticated provider transaction API as the
authoritative payment-settlement signal when one is available. Verify webhook
signatures, reconcile the provider transaction/reference to the persisted
target on the server, and make the paid/confirmed transition through trusted
server code. Keep OCR as supplemental fraud screening and evidence capture; it
should never replace provider confirmation. Until that integration exists, the
owner must verify funds directly in the provider account.

Local verification commands:

```bash
deno check supabase/functions/verify-gcash-receipt/index.ts
deno test supabase/functions/_shared/*_test.ts
node --check supabase-config.js
```
