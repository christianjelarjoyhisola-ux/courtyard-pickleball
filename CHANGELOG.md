# Changelog — CourtYard Pickleball (Sibagat, Agusan del Sur)

All notable changes to this project are documented here.
Format: `[YYYY-MM-DD] — Type: Description (files affected)`
Types: **Added**, **Changed**, **Fixed**, **Removed**, **Security**, **DB**

---

## [2026-06-14] — Google AdSense, Full-App Realtime & Weekly Billing Audit

### Added
- **Google AdSense** — site `courtyardpickleball.club` connected, verified, and approved ("Ready"). AdSense code snippet added to the `<head>` of `index.html`, `login.html`, and `admin.html` (publisher `ca-pub-6965664743687392`)
- **Full-app realtime** — live updates with no manual refresh across the public site and admin dashboard:
  - Public (`index.html`): realtime channel `public-rt` now subscribes to `bookings`, `courts`, `settings`, `blocked_dates`, and `open_play_registrations` — maintenance, blocked dates, open play, and rate changes all appear live (debounced via `refreshLiveViews()`)
  - Admin (`admin.html`): new `startAdminRealtime()` channel `admin-rt` subscribes to all 7 tables and re-renders the **current** section on change. `goto()` now tracks `_curSection`; guards skip re-render while a form field is focused or a modal is open
- **Billing audit trail** — each weekly statement now records the exact booking refs it billed (`weekly_fees.billed_refs`), and each booking is stamped with `billed_at` + `weekly_fee_id` so a booking is billed **exactly once**
- **Weekly remittance terms** in the court-owner agreement (now **Version 2**, forces re-sign): Section 3 renamed "Platform Booking Fee & Weekly Remittance" — defines the billable event (confirmed booking), customer-collected fee, weekly Mon–Sun statement, 5-day GCash due date with proof, and non-payment → suspension

### Changed
- **Platform fee is now a fixed constant** `PLATFORM_FEE_PER_BOOKING = 15` in `admin.html` — permanent ₱15.00 per confirmed booking that never changes. `generateWeeklyStatement()` no longer reads `settings.maintenance_fee` (that setting belongs to the separate monthly Maintenance report)
- **Weekly statement generation is now idempotent** — regenerating a week updates the existing statement (one per owner/week) instead of creating a duplicate, refuses to regenerate a paid statement, and stamps the billed bookings

### Security
- Admin realtime re-render is suppressed while the user is editing a form field or has a modal open — prevents clobbering in-progress input

### DB
- `20260614_billing_audit.sql` — added `bookings.billed_at` (timestamptz), `bookings.weekly_fee_id` (uuid), `weekly_fees.billed_refs` (jsonb); indexes `idx_bookings_billed_at`, `idx_bookings_weekly_fee_id`. Applied to live database
- All 7 tables added to the `supabase_realtime` publication with `replica identity full`: `accounts`, `blocked_dates`, `bookings`, `courts`, `open_play_registrations`, `settings`, `weekly_fees`

**Files affected:** `index.html`, `admin.html`, `login.html`, `supabase-config.js`, `supabase/migrations/20260614_billing_audit.sql`

---

## [2026-06-12] — Date Picker Label & Alignment

### Added
- **"SELECT DATE" label** above the date input in the court card times header — small uppercase muted text so players notice the date is changeable

### Fixed
- `display: none` leftover from an earlier experiment was hiding the date picker — removed to restore it
- `align-items: flex-start` on `.cc-times-head` caused uneven vertical spacing when the label was added — changed to `align-items: center` so the left block (title + subtitle) and right block (SELECT DATE + input) are symmetrically centered

**Files affected:** `index.html`

---

## [2026-06-12] — Mobile UX, Slot Colors & Past-Date Booking Fix

### Fixed
- **Past date booking** — Selecting a past date (e.g. Jun 11 when today is Jun 12) now marks all slots as "Past" and blocks booking. `toggleCardSlot()` also guards against past-date calls with a toast error
- `isPastDate_` flag added to `renderCourtsGrid()` slot renderer; availability badge now uses `curHour_badge = 999` for past dates (shows 0 available)

### Changed
- **Slot color redesign** — New dark navy + blue palette matching the logo/brand theme:
  - Available: `#0d1b2e` bg + blue-tint border (`rgba(37,99,235,.4)`), price in `#60a5fa`
  - Selected: Solid `#1d4ed8` blue fill + white text + blue glow ring — fully solid, no ambiguity
  - Booked/Taken: `#1c0a0a` dark red bg + red strikethrough time + masked name in red
  - Past: 38% opacity ghost — clearly unclickable
  - Hover transitions now use `@media (hover: hover)` — no stuck hover states on touch devices
  - Removed `scale()` and `translateY()` transforms on selected/hover — eliminates layout jank on mobile

**Files affected:** `index.html`

---

## [2026-06-12] — Mobile-Friendly Admin Dashboard

### Added
- **Sidebar backdrop overlay** — `#sidebarOverlay` div with dark semi-transparent background; tapping it closes the sidebar on mobile
- `toggleSidebar()` JS function — replaces inline `onclick` on burger button; syncs sidebar and overlay open/close state
- `.sidebar-overlay` CSS class with `backdrop-filter: blur(2px)`

### Changed
- **Responsive CSS overhaul** — replaced scattered media queries with consolidated breakpoints:
  - `≤900px`: sidebar fixed overlay, burger visible, `topbar` padding reduced to `14px 16px 0`
  - `≤700px`: `.toolbar` stacks vertically; nav badge hidden; Sign Out becomes ⏻ icon; reports period filter stacks; sidebar gets `box-shadow`
  - `≤480px`: modal becomes **bottom sheet** (slides up, `border-radius: 20px 20px 0 0`); modal footer buttons stack vertically
- Sidebar `open` state now includes `box-shadow: 4px 0 24px rgba(0,0,0,0.3)`
- `.role-bdg` gets `white-space: nowrap; flex-shrink: 0` — prevents "SYSTEM OWNER" from wrapping to two lines
- Sign Out button: text wrapped in `.sign-out-text` (hidden ≤700px) + `.sign-out-icon` ⏻ (shown ≤700px)
- Nav actions gap reduced to `6px` on mobile; `.btn-d` reduced to `8px 10px` padding on mobile
- `goto()` now also removes `.show` from `#sidebarOverlay` when navigating

**Files affected:** `admin.html`

---

## [2026-06-12] — Splash Screen Bottom Label Fix

### Fixed
- `.sp-bottom` ("COURTYARD PICKLEBALL · SIBAGAT, AGUSAN DEL SUR") was positioned at bottom-left instead of bottom-center
- Added `left: 50%; transform: translateX(-50%); white-space: nowrap` to center it horizontally

**Files affected:** `index.html`

---

## [2026-06-12] — Staff Login Link in Footer + Platform Fee Panel

### Added
- **Staff Login link** added to footer Support section in `index.html` — styled with muted color + separator line above it for subtle admin access
- **Platform Fee panel** in admin Payments section (`data-perm="owner_only"`) — System Owner configures per-hour or flat booking fee; labeled "SYSTEM OWNER" badge

### Changed
- Platform fee / developer rate moved from Courts section → Payments section; only visible to `owner` role

**Files affected:** `index.html`, `admin.html`

---

## [2026-06-13] — Slot Locking, Receipt Validation & Ghost Booking Fixes

### Added
- **Slot reservation on "Book Now"** — clicking Book Now immediately INSERTs a slim `verifying` booking (`status='verifying'`) before the form opens, so no other player can claim the same slot during the 15-minute fill-in window. If the slot is already taken, a toast blocks entry instead of letting two users race to the same DB insert.
- **15-minute countdown timer** (`#slotCountdown` banner) inside the booking modal — turns red in the last 60 seconds. On expiry the reservation is auto-cancelled server-side and the modal closes.
- **Yellow "⏳ Processing…" slot state** — `verifying` bookings render as animated yellow slots so other users immediately see a slot is being held. Slots held longer than 15 minutes automatically render as available (render-time expiry, no write needed).
- **`isHeldVerifying()` / `bookingHoldsSlot()` helpers** — centralise the reservation-window check so both the card grid and date-picker grid always agree on which slots are held vs free.
- **`expireStaleVerifyingBookings()`** called on DOMContentLoaded — cancels any `verifying` bookings older than 15 minutes in the DB on page load.
- **Receipt upload made mandatory** for GCash / GoTyme / PNB payments — the upload zone flashes red and scrolls into view if the user tries to submit without a file.
- **Cloudflare Pages deployment** — project connected to `jelarpickleball/courtyard-pickleball` GitHub repo; auto-deploys to `courtyardpickleball.pages.dev` on every push to `main`.

### Fixed
- **Ghost bookings / stuck "Processing…" slots** — root cause was a DB constraint: `bookings_payment_status_check` did not allow `'rejected'`, so every rejection UPDATE rolled back and the booking stayed `status='verifying'` forever. Fixed by adding `'rejected'` to the allowed values.
- **Edge function UPDATE silently failing for DUPLICATE_IMAGE/DUPLICATE_REF rejections** — the single large UPDATE wrote 10 fields atomically; any transient failure on one receipt_* metadata column rolled back the entire UPDATE including the critical `status='cancelled'`. Refactored to **two-pass UPDATE**: Pass 1 writes only `status` + `payment_status` (slot-gating fields) with `.select()` RETURNING to verify it landed; Pass 2 writes receipt_* metadata. A last-resort fallback issues a minimal `SET status='cancelled'` if Pass 1 fails, so the slot is freed no matter what.
- **`renderCourts()` not refreshing the active date-picker grid after rejection** — `renderCourts()` only refreshes the "today" card grid. After OCR rejection the code now also calls `onCardDate(courtId, date)` to free the slot in whichever date was selected at submit time.
- **`prevent_double_booking()` DB trigger blocking new reservations on expired holds** — trigger was updated to ignore `verifying` rows older than 15 minutes (`AND NOT (b.status='verifying' AND b.created_at < now() - interval '15 minutes')`), so an abandoned hold can no longer block a new booking at the DB level even if cleanup writes never ran.
- **30-second submit cooldown resetting after validation failures** — validation errors no longer consume the cooldown timer; only actual submission attempts count.
- **`updateBooking()` missing field mappings** — added `contactNumber`, `email`, `total`, `paymentMethod` to the mapper so slot-reservation-to-booking upgrades carry all customer fields correctly.

### Changed
- **`submitBooking()` UPDATE flow** — instead of a fresh INSERT, re-uses the reservation ref from `proceedToBook()` and UPDATEs the existing `verifying` row with full customer details, avoiding a second slot-conflict check and ensuring the reservation holds atomically through checkout.
- **Rejection message copy** — changed from "your booking is on hold" to "your booking has been cancelled — please make a new booking and upload a valid GCash receipt."
- **`expireStaleVerifyingBookings()` cutoff** aligned to `RESERVATION_MINUTES` (15 min) instead of the previous hardcoded 10 min.
- **Edge function response** now includes `warning` / `metadataWarning` fields when DB updates fail, making errors observable client-side instead of silently swallowed.

### DB
- `bookings_payment_status_check` constraint updated to include `'rejected'`
- `prevent_double_booking()` trigger updated to be time-aware (ignores expired `verifying` rows)
- Migration: `supabase/migrations/20260613_verifying_status.sql` — adds `'verifying'` to `bookings_status_check`

### Security
- Receipt upload required server-side (edge function always runs OCR) — client cannot skip verification by omitting the file
- Duplicate image / reference detection fires before OCR cost is incurred (hash check short-circuits)
- All rejection paths free the slot server-side regardless of client state (two-pass UPDATE + fallback)

**Files affected:** `index.html`, `supabase-config.js`, `supabase/functions/verify-gcash-receipt/index.ts`, `supabase/migrations/20260613_verifying_status.sql`

---



### Added
- **`verify-gcash-receipt` Edge Function** — server-side receipt image verification before a booking is confirmed
- **OCR.space integration** (`https://api.ocr.space/parse/image`, `OCREngine=2`) as primary OCR provider; Google Vision API was attempted but rejected (billing disabled on GCP project `consummate-mark-499309-c7`, returns `403 BILLING_DISABLED`)
- `runOCR(visionKey, ocrSpaceKey, base64, contentType)` helper — tries Vision API first, falls back to OCR.space automatically
- `OCRSPACE_API_KEY` secret set in Supabase (`K82251457688957`, registered free key — 25k scans/month)
- **Hard flag `IMAGE_UNREADABLE`** — no OCR text extracted (blank image, random photo, non-receipt) → automatically rejected; prevents submitting arbitrary images to bypass payment gate
- **Soft flag `OCR_UNAVAILABLE`** — OCR service itself unreachable → routes to manual review instead of hard reject
- **Decision routing**:
  - Any hard flag → `rejected`
  - Any soft flag → `manual_review`
  - Clean (ref match, amount match, correct merchant) → `auto_approved`: sets `bookings.status = 'confirmed'` and `payment_status = 'paid'` or `'downpayment_paid'`
- Migration: `supabase/migrations/20260613_receipt_verification.sql`

### Security
- Reference number cross-checked against booking record server-side — client cannot influence the comparison
- Receipt reuse prevented: each reference number is validated as unique per booking
- All verification decisions (approved / manual_review / rejected) stored with flag list for audit trail

### Verified
- End-to-end tested against live Edge Function:
  - Real receipt → `auto_approved` + `status=confirmed` ✓
  - Random image → `rejected (IMAGE_UNREADABLE)` ✓
  - Wrong-ref receipt → `rejected (REF_MISMATCH)` ✓

**Files affected:** `supabase/functions/verify-gcash-receipt/index.ts`, `supabase/migrations/20260613_receipt_verification.sql`

---

## [2026-06-15] — 3-Tier Role-Based Access Control

### Added
- New 3-tier role system replacing old 2-role model (`developer/manager`):
  - **System Owner** (`owner`) — full access: all sections + account management
  - **Court Owner** (`court_owner`) — operations & settings, no account management
  - **Court Staff** (`staff`) — front-desk only: bookings, payments, open play
- Permission matrix defined in `supabase-config.js → window.Auth.ROLE_PERMISSIONS`
- `Auth.can(action, role)` and `Auth.permissionsFor(role)` helpers for checking permissions
- Role selector dropdown in the Add/Edit Account modal
- `applyRoleVisibility(role)` function in `admin.html` — hides sidebar nav items and buttons via `data-perm` attributes
- Navigation guard in `goto()` — prevents accessing sections without permission
- 3 default accounts created in Supabase: `sysowner`, `courtowner`, `courtstaff`
- Migration file: `supabase/migrations/20260615_three_tier_roles.sql`

### Changed
- `admin.html`: sidebar nav items now carry `data-perm` attributes; role badge updated for 3 roles; booking delete guard uses `Auth.can('booking_delete')` instead of `isDev` check; fallback session role changed from `admin` → `staff` (least-privilege)
- `supabase-config.js`: `window.Auth` extended with role model, `ROLES`, `ROLE_LABELS`, `ROLE_PERMISSIONS`, `can()`, `permissionsFor()`, `hasRole()`; account `add()` default role changed from `manager` → `staff`; login fallback role changed from `admin` → `staff`
- `auth.js`: updated DEFAULT_ACCOUNTS to use `owner` role; `hasRole()` now checks `owner` for full access; `addManager()` accepts role parameter
- `create-accounts.js`: updated to 3 accounts (`owner`, `court_owner`, `staff`) with new emails
- `SETUP_NEW_SUPABASE.sql`: accounts table default role `manager` → `staff`, CHECK constraint updated

### DB
- Dropped old `accounts_role_check` constraint (`developer/admin/manager`)
- Remapped existing rows: `developer→owner`, `admin→court_owner`, `manager→staff`
- Added new `accounts_role_check` constraint: `('owner','court_owner','staff')`

**Files affected:** `admin.html`, `supabase-config.js`, `auth.js`, `create-accounts.js`, `SETUP_NEW_SUPABASE.sql`, `supabase/migrations/20260615_three_tier_roles.sql`, `CHANGELOG.md`

---

## [2026-06-12] — Rebrand + Color Theme Update

### Changed
- Renamed all instances of "Smash Grove" → "CourtYard Pickleball" across all pages
- Updated color theme to match CourtYard Pickleball logo: dark navy background + vivid blue accent
  - Primary: `#2563eb`, Dark: `#1848c8`, Glow: `rgba(37,99,235,.25)`
  - Background: `#0c1220`, Card: `#111b2d`, Border: `#1e3252`, Input: `#0e1828`
  - Admin light mode green → blue: `#2563eb / #1848c8`, bg `#dbeafe`
  - Admin dark mode green → blue: `#3b82f6 / #2563eb`, bg `#0d1f4a`
  - Login page hardcoded rgba green values updated to blue equivalents
- Navbar background changed from greenish `rgba(13,26,13,.95)` to navy `rgba(12,18,32,.95)`

**Files affected:** `index.html`, `admin.html`, `login.html`, `CHANGELOG.md`

---

## [2026-06-12] — Session: Initial Changelog Created

### Project State Snapshot (as of this date)
This is the baseline snapshot of the project when the changelog was introduced.

#### Pages
- `index.html` — Main public booking page (Smash Grove branding, dark/light mode, court booking form)
- `admin.html` — Admin dashboard with analytics charts (`chart.min.js`), booking management, dark/light theme
- `login.html` — Admin login page with Supabase auth

#### Scripts
- `script.js` — Main booking logic (form submission, slot availability, payment flow)
- `admin.js` — Admin dashboard logic (booking list, status updates, filters, charts)
- `auth.js` — Authentication helpers (session check, redirect guards)
- `supabase-config.js` — Supabase client initialization + global `window._supabase` + JSON/error helpers
- `create-accounts.js` — Utility for creating admin accounts
- `setup-db.js` — One-time DB setup utility

#### Styling
- `style.css` — Shared global styles

#### Supabase Edge Functions
- `create-payment-session` — Creates a secure GCash/PayMongo payment session server-side
- `payment-webhook` — Receives payment provider callbacks and updates booking payment status
- `send-confirmation-email` — Sends booking confirmation email to customer
- `send-reschedule-email` — Sends reschedule notification email
- `send-telegram-notification` — Sends Telegram alert to admin on new booking

#### Database Migrations (applied)
- `001_prevent_double_booking.sql` — Prevents overlapping bookings on the same court/time slot
- `002_enable_rls.sql` — Enables Row Level Security on all tables
- `20260227_payment_security.sql` — Adds `payment_sessions` table + payment columns on `bookings`
- `20260309_fix_payment_status_constraint.sql` — Fixes payment status check constraint
- `20260604_open_play_payment.sql` — Adds open play payment support

#### Docs
- `PAYMENT_SETUP.md` — Step-by-step guide for GCash/PayMongo payment integration
- `SETUP_NEW_SUPABASE.sql` — Full SQL script to bootstrap a fresh Supabase project

#### Stack
- Frontend: Vanilla HTML/CSS/JS (no build step)
- Backend: Supabase (Postgres + Auth + Edge Functions)
- Payment: PayMongo (GCash)
- Notifications: Telegram Bot + Email
- Local dev: `npx serve . -l 3000`

---

<!-- TEMPLATE — copy this block when making changes:

## [YYYY-MM-DD] — Brief title

### Added
- 

### Changed
- 

### Fixed
- 

### Removed
- 

**Files affected:** `file1.js`, `file2.html`

-->
