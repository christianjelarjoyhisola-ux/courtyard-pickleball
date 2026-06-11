# Changelog — CourtYard Pickleball (Sibagat, Agusan del Sur)

All notable changes to this project are documented here.
Format: `[YYYY-MM-DD] — Type: Description (files affected)`
Types: **Added**, **Changed**, **Fixed**, **Removed**, **Security**, **DB**

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
