// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
const SUPABASE_URL  = 'https://ruoyywzehhgkkxswicoa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1b3l5d3plaGhna2t4c3dpY29hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExOTUwNjMsImV4cCI6MjA5Njc3MTA2M30.BpzsmRUjcd0IVpwZplZLFqDokbzQKF03SJ2SXaEi5RI';

// Initialize Supabase client (uses UMD global loaded from CDN)
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

function _safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
}

function _extractFnError(err, fallback = 'Edge Function request failed') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error_description) return String(err.error_description);
  if (err.error) return String(err.error);
  if (err.context) {
    const parsed = _safeJsonParse(err.context);
    if (parsed?.error) return String(parsed.error);
    if (typeof err.context === 'string') return err.context;
  }
  try { return JSON.stringify(err); } catch(_) { return fallback; }
}

async function _invokePaymentSessionFallback(payload) {
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/create-payment-session`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  let res;
  try {
    res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Edge Function endpoint (${fnUrl}). ${_extractFnError(networkErr, 'Network error')}`);
  }

  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) {
    const reason = json?.error || txt || `HTTP ${res.status}`;
    throw new Error(`Edge Function HTTP ${res.status}: ${reason}`);
  }
  if (!json || json.ok !== true || !json.checkoutUrl) {
    throw new Error(`Invalid Edge Function response: ${txt || 'empty body'}`);
  }
  return json;
}

// =============================================
// ROW ↔ JS OBJECT MAPPING
// SQL uses snake_case; JS objects use camelCase
// =============================================
function rowToBooking(r) {
  return {
    ref:           r.ref,
    fullName:      r.full_name,
    contactNumber: r.contact_number,
    email:         r.email,
    courtId:       r.court_id,
    courtName:     r.court_name,
    date:          r.date,
    slots:         r.slots || [],
    startTime:     r.start_time,
    endTime:       r.end_time,
    duration:      r.duration,
    rate:          r.rate,
    total:         r.total,
    paymentMethod: r.payment_method,
    paymentFlow:   r.payment_flow || null,
    paymentStatus: r.payment_status || 'unpaid',
    paymentProvider: r.payment_provider || null,
    paymentSessionId: r.payment_session_id || null,
    paymentCheckoutUrl: r.payment_checkout_url || null,
    paidAt:        r.paid_at || null,
    gcashRef:      r.gcash_ref || null,
    downpayment:   r.downpayment || null,
    receiptStatus:     r.receipt_status || 'none',
    receiptFlags:      r.receipt_flags || [],
    receiptExtracted:  r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptImageUrl:   r.receipt_image_url || null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    status:        r.status,
    createdAt:     r.created_at,
  };
}

function bookingToRow(b) {
  return {
    ref:            b.ref,
    full_name:      b.fullName,
    contact_number: b.contactNumber,
    email:          b.email,
    court_id:       b.courtId,
    court_name:     b.courtName,
    date:           b.date,
    slots:          b.slots,
    start_time:     b.startTime,
    end_time:       b.endTime,
    duration:       b.duration,
    rate:           b.rate,
    total:          b.total,
    payment_method: b.paymentMethod,
    payment_flow:   b.paymentFlow || null,
    payment_status: b.paymentStatus || 'unpaid',
    payment_provider: b.paymentProvider || null,
    payment_session_id: b.paymentSessionId || null,
    payment_checkout_url: b.paymentCheckoutUrl || null,
    paid_at:        b.paidAt || null,
    gcash_ref:      b.gcashRef || null,
    downpayment:    b.downpayment || null,
    status:         b.status,
    created_at:     b.createdAt,
  };
}

function rowToCourt(r) {
  return {
    id:           r.id,
    name:         r.name,
    desc:         r.description,
    rate:         r.rate,
    blocked:      r.blocked,
    feats:        r.feats || [],
    photo:        r.photo || '',
    rateSchedule: r.rate_schedule || null,
  };
}

function courtToRow(c) {
  return {
    id:            c.id,
    name:          c.name,
    description:   c.desc,
    rate:          c.rate,
    blocked:       c.blocked,
    feats:         c.feats || [],
    photo:         c.photo || null,
    rate_schedule: c.rateSchedule || null,
  };
}

function rowToAccount(r) {
  return {
    id:        r.id,
    username:  r.username,
    password:  r.password,
    role:      r.role,
    fullName:  r.full_name,
    email:     r.email,
    createdAt: r.created_at,
  };
}

function accountToRow(a) {
  return {
    id:         a.id,
    username:   a.username,
    password:   a.password,
    role:       a.role,
    full_name:  a.fullName,
    email:      a.email,
    created_at: a.createdAt,
  };
}

// =============================================
// DB — Async Data Layer (replaces localStorage)
// =============================================
window.DB = {

  // ---- COURTS ----
  async getCourts() {
    const { data, error } = await _sb.from('courts').select('*').order('id');
    if (error) { console.error('getCourts:', error); return []; }
    return data.map(rowToCourt);
  },

  async saveCourt(court) {
    const { error } = await _sb.from('courts').upsert(courtToRow(court));
    if (error) { console.error('saveCourt:', error); throw error; }
  },

  async deleteCourt(id) {
    const { error } = await _sb.from('courts').delete().eq('id', id);
    if (error) console.error('deleteCourt:', error);
  },

  // ---- BOOKINGS ----
  async getBookings() {
    const { data, error } = await _sb.from('bookings').select('*').order('created_at', { ascending: false });
    if (error) { console.error('getBookings:', error); return []; }
    return data.map(rowToBooking);
  },

  async addBooking(booking) {
    // Check for slot conflicts before inserting
    const { data: existing } = await _sb
      .from('bookings')
      .select('ref, slots')
      .eq('court_id', booking.courtId)
      .eq('date', booking.date)
      .neq('status', 'cancelled');

    if (existing) {
      const bookedSlots = existing.flatMap(b => b.slots || []);
      const conflict = (booking.slots || []).some(s => bookedSlots.includes(s));
      if (conflict) throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
    }

    const { error } = await _sb.from('bookings').insert(bookingToRow(booking));
    if (error) { console.error('addBooking:', error); throw error; }
  },

  async getBookingByRef(ref) {
    const { data, error } = await _sb.from('bookings').select('*').eq('ref', ref).single();
    if (error) { console.error('getBookingByRef:', error); return null; }
    return rowToBooking(data);
  },

  async updateBooking(ref, updates) {
    // Map only the fields provided (camelCase → snake_case)
    const row = {};
    if (updates.status    !== undefined) row.status = updates.status;
    if (updates.fullName  !== undefined) row.full_name = updates.fullName;
    if (updates.contactNumber !== undefined) row.contact_number = updates.contactNumber;
    if (updates.email     !== undefined) row.email = updates.email;
    if (updates.total     !== undefined) row.total = updates.total;
    if (updates.paymentMethod !== undefined) row.payment_method = updates.paymentMethod;
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.paymentFlow !== undefined) row.payment_flow = updates.paymentFlow;
    if (updates.paymentProvider !== undefined) row.payment_provider = updates.paymentProvider;
    if (updates.paymentSessionId !== undefined) row.payment_session_id = updates.paymentSessionId;
    if (updates.paymentCheckoutUrl !== undefined) row.payment_checkout_url = updates.paymentCheckoutUrl;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.gcashRef !== undefined) row.gcash_ref = updates.gcashRef;
    if (updates.downpayment !== undefined) row.downpayment = updates.downpayment;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startTime !== undefined) row.start_time = updates.startTime;
    if (updates.endTime !== undefined) row.end_time = updates.endTime;
    if (updates.duration !== undefined) row.duration = updates.duration;
    if (updates.slots !== undefined) row.slots = updates.slots;
    const { error } = await _sb.from('bookings').update(row).eq('ref', ref);
    if (error) { console.error('updateBooking:', error); throw error; }
  },

  async deleteBooking(ref) {
    const { error } = await _sb.from('bookings').delete().eq('ref', ref);
    if (error) console.error('deleteBooking:', error);
  },

  // ---- OPEN PLAY REGISTRATIONS ----
  async getOpenPlayRegistrations() {
    const { data, error } = await _sb.from('open_play_registrations').select('*').order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayRegistrations:', error); return []; }
    return data;
  },

  async addOpenPlayRegistration(reg) {
    const { error } = await _sb.from('open_play_registrations').insert({
      full_name: reg.fullName,
      court_id: String(reg.courtId),
      court_name: reg.courtName,
      date: reg.date,
      hour: reg.hour,
      time_label: reg.timeLabel,
      payment_type: reg.paymentType,
      payment_method: reg.paymentMethod || 'cash',
      gcash_ref: reg.gcashRef || null,
      payment_status: 'pending',
      amount: reg.amount,
      created_at: new Date().toISOString(),
    });
    if (error) { console.error('addOpenPlayRegistration:', error); throw error; }
  },

  async updateOpenPlayRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef      !== undefined) row.gcash_ref      = updates.gcashRef;
    const { error } = await _sb.from('open_play_registrations').update(row).eq('id', id);
    if (error) { console.error('updateOpenPlayRegistration:', error); throw error; }
  },

  async getOpenPlayCountForDate(date) {
    const { count, error } = await _sb.from('open_play_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('date', date);
    if (error) { console.error('getOpenPlayCountForDate:', error); return 0; }
    return count || 0;
  },

  async deleteOpenPlayRegistration(id) {
    const { error } = await _sb.from('open_play_registrations').delete().eq('id', id);
    if (error) console.error('deleteOpenPlayRegistration:', error);
  },

  // ---- BLOCKED DATES ----
  async getBlockedDates() {
    const { data, error } = await _sb.from('blocked_dates').select('date').order('date');
    if (error) { console.error('getBlockedDates:', error); return []; }
    return data.map(r => r.date);
  },

  async addBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').insert({ date, created_at: new Date().toISOString() });
    if (error) console.error('addBlockedDate:', error);
  },

  async removeBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').delete().eq('date', date);
    if (error) console.error('removeBlockedDate:', error);
  },

  // ---- ACCOUNTS ----
  async getAccounts() {
    const { data, error } = await _sb.from('accounts').select('*').order('created_at');
    if (error) { console.error('getAccounts:', error); return []; }
    return data.map(rowToAccount);
  },

  async saveAccount(account) {
    const { error } = await _sb.from('accounts').upsert(accountToRow(account));
    if (error) { console.error('saveAccount:', error); throw error; }
  },

  async deleteAccount(id) {
    const { error } = await _sb.from('accounts').delete().eq('id', id);
    if (error) console.error('deleteAccount:', error);
  },

  // ---- SETTINGS ----
  async getSettings() {
    const { data, error } = await _sb.from('settings').select('*');
    if (error) { console.error('getSettings:', error); return {}; }
    const out = {};
    data.forEach(r => out[r.key] = r.value);
    return out;
  },

  async saveSetting(key, value) {
    const { error } = await _sb.from('settings').upsert({ key, value });
    if (error) { console.error('saveSetting:', error); throw error; }
  },

  async createPaymentSession(payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_ANON_KEY).');
    }
    const { data, error } = await _sb.functions.invoke('create-payment-session', { body: payload });
    if (!error && data) return data;

    // Fallback path: direct HTTP call to the function endpoint. This helps diagnose
    // invoke-wrapper issues and still allows checkout if endpoint is reachable.
    try {
      return await _invokePaymentSessionFallback(payload);
    } catch (fallbackErr) {
      const baseReason = _extractFnError(error, 'Failed to send a request to the Edge Function');
      const fbReason = _extractFnError(fallbackErr, 'Fallback call failed');
      console.error('createPaymentSession.invokeError:', error);
      console.error('createPaymentSession.fallbackError:', fallbackErr);
      throw new Error(`${baseReason}. Fallback failed: ${fbReason}`);
    }
  },

  // Verify an uploaded GCash/GoTyme/PNB receipt image via the Edge Function.
  // payload: { bookingRef, provider, imageBase64, contentType }
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', { body: payload });
    if (!error && data) return data;

    // Fallback: direct HTTP call (mirrors createPaymentSession fallback).
    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const sess = await _sb.auth.getSession();
    const accessToken = sess?.data?.session?.access_token || '';
    const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  },

  // Request a short-lived signed URL to view a stored receipt (admin only).
  async getReceiptSignedUrl(bookingRef) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', bookingRef },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  // ---- SEED DEFAULT DATA (runs once on first load) ----
  async seedDefaultData() {
    const courts = await this.getCourts();
    if (courts.length === 0) {
      await _sb.from('courts').insert([
        { id: 'c1', name: 'Court Alpha', description: 'Outdoor · Air passing through · Standard Flooring', rate: 350, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
        { id: 'c2', name: 'Court Beta',  description: 'Outdoor · Air passing through · Standard Flooring', rate: 280, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
      ]);
    }

    const accounts = await this.getAccounts();
    if (accounts.length === 0) {
      await _sb.from('accounts').insert([{
        id: 'dev_001', username: 'developer', password: 'dev123',
        role: 'developer', full_name: 'Super Admin',
        email: 'dev@pickleballhub.com', created_at: new Date().toISOString(),
      }]);
    }
  },

  // Check if user has accepted the current agreement version
  async getAgreement(userId, version = 1) {
    const { data } = await _sb.from('agreements').select('id, full_name, agreed_at').eq('user_id', userId).eq('version', version).maybeSingle();
    return data || null;
  },

  // Save signed agreement
  async saveAgreement({ userId, email, fullName, role, signatureData, ipAddress, userAgent, version = 1 }) {
    const { error } = await _sb.from('agreements').upsert({
      user_id:        userId,
      email,
      full_name:      fullName,
      role,
      version,
      signature_data: signatureData,
      ip_address:     ipAddress || null,
      user_agent:     userAgent || null,
      agreed_at:      new Date().toISOString(),
    }, { onConflict: 'user_id,version' });
    if (error) throw error;
  },
};

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payments, open play)
  ROLES: ['owner', 'court_owner', 'staff'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'bookings', 'reports', 'courts', 'open_play', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'bookings', 'reports', 'courts', 'open_play', 'maintenance', 'payments', 'export', 'settings'],
    staff:       ['bookings', 'open_play', 'payments'],
  },

  permissionsFor(role) {
    return this.ROLE_PERMISSIONS[role] || [];
  },

  can(action, role) {
    const r = role || (this.getSession() && this.getSession().role);
    return this.permissionsFor(r).includes(action);
  },

  hasRole(role) {
    const sess = this.getSession();
    if (!sess) return false;
    if (sess.role === 'owner') return true; // system owner has all access
    return sess.role === role;
  },

  async login(email, password, remember = false) {
    // Sign in via Supabase Auth — establishes a verified JWT session
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false };

    // Fetch role/name from accounts table (now accessible as authenticated user)
    const { data: acc } = await _sb.from('accounts').select('*').eq('email', email).single();
    const session = acc
      ? { ...rowToAccount(acc), loginAt: new Date().toISOString() }
      : { id: data.user.id, email: data.user.email, role: 'staff', fullName: 'Court Staff', loginAt: new Date().toISOString() };

    // Use localStorage when "remember me" is checked so session survives browser close
    const store = remember ? localStorage : sessionStorage;
    store.setItem('pb_session', JSON.stringify(session));
    if (remember) localStorage.setItem('pb_remember', '1');
    return { ok: true };
  },

  getSession() {
    // Check localStorage first (remembered), then sessionStorage (tab-only)
    const s = localStorage.getItem('pb_session') || sessionStorage.getItem('pb_session');
    return s ? JSON.parse(s) : null;
  },

  requireAuth() {
    const sess = this.getSession();
    if (!sess) { window.location.href = 'login.html'; return null; }
    return sess;
  },

  async logout() {
    await _sb.auth.signOut();
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    localStorage.removeItem('pb_remember');
    window.location.href = 'login.html';
  },

  // Used by admin.html account management
  async getAll() {
    return DB.getAccounts();
  },

  async add(d) {
    const all = await DB.getAccounts();
    if (all.find(x => x.username === d.username)) return { ok: false, msg: 'Username taken.' };

    // Create a real Supabase Auth user so the account can actually log in
    const { data, error } = await _sb.auth.signUp({ email: d.email, password: d.password });
    if (error) return { ok: false, msg: error.message };
    if (!data.user) return { ok: false, msg: 'Signup failed — no user returned.' };

    const acc = {
      id: data.user.id,
      fullName: d.fullName,
      username: d.username,
      email: d.email,
      role: this.ROLES.includes(d.role) ? d.role : 'staff',
      createdAt: new Date().toISOString(),
    };
    try { await DB.saveAccount(acc); return { ok: true }; }
    catch(e) { return { ok: false, msg: 'Auth user created but profile save failed.' }; }
  },

  async update(id, d) {
    const all = await DB.getAccounts();
    const existing = all.find(x => x.id === id);
    if (!existing) return { ok: false };
    try { await DB.saveAccount({ ...existing, ...d }); return { ok: true }; }
    catch(e) { return { ok: false }; }
  },

  async del(id) {
    await DB.deleteAccount(id);
    return { ok: true };
  },
};
