# Changelog — CourtYard Pickleball (Sibagat, Agusan del Sur)

All notable changes to this project are documented here.
Format: `[YYYY-MM-DD] — Type: Description (files affected)`
Types: **Added**, **Changed**, **Fixed**, **Removed**, **Security**, **DB**

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
