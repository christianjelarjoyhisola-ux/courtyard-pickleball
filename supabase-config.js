// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
const SUPABASE_URL  = 'https://jlowekvmzkvljqcjolqf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_xfeJ6GwlRkVy79Osc8kvJg_SkYbQ-YC';

const PB_RECEIPT_TIMEOUT_MS = 90000;
const PB_PUBLIC_HOLD_MINUTES = 15;
const PB_RECEIPT_TOKEN_STORAGE_PREFIX = 'pb_receipt_token_v1';
const _pbReceiptTokenMemory = new Map();

async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_RECEIPT_TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' && !init.signal ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      reject(new Error('Receipt verification timed out. Your reservation is saved; do not pay again.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, controller ? { ...init, signal: controller.signal } : init),
      timeout,
    ]);
  } catch (err) {
    if (timedOut || controller?.signal.aborted) {
      throw new Error('Receipt verification timed out. Your reservation is saved; do not pay again.');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _pbBytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _pbBytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function _pbReceiptTokenStorageKey(targetType, targetId) {
  return `${PB_RECEIPT_TOKEN_STORAGE_PREFIX}:${String(targetType || '')}:${String(targetId || '')}`;
}

function _pbRememberReceiptToken(targetType, targetId, receiptToken) {
  if (!targetType || !targetId || !receiptToken) throw new Error('Receipt token target is incomplete.');
  const key = _pbReceiptTokenStorageKey(targetType, targetId);
  _pbReceiptTokenMemory.set(key, receiptToken);
  try { sessionStorage.setItem(key, receiptToken); } catch (_) {}
  return receiptToken;
}

function _pbGetReceiptToken(targetType, targetId) {
  const key = _pbReceiptTokenStorageKey(targetType, targetId);
  if (_pbReceiptTokenMemory.has(key)) return _pbReceiptTokenMemory.get(key);
  let token = '';
  try { token = sessionStorage.getItem(key) || ''; } catch (_) {}
  if (token) _pbReceiptTokenMemory.set(key, token);
  return token;
}

function _pbForgetReceiptToken(targetType, targetId) {
  if (!targetType || !targetId) return false;
  const key = _pbReceiptTokenStorageKey(targetType, targetId);
  const existed = _pbReceiptTokenMemory.delete(key);
  try {
    const stored = sessionStorage.getItem(key) != null;
    sessionStorage.removeItem(key);
    return existed || stored;
  } catch (_) {
    return existed;
  }
}

async function _pbCreateReceiptCredential(targetType = '', targetId = '') {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error('This browser cannot securely authorize a receipt upload. Please use an updated browser.');
  }
  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  const receiptToken = _pbBytesToBase64Url(random);
  // The server hashes the exact UTF-8 token string received in multipart form.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(receiptToken));
  const receiptTokenHash = _pbBytesToHex(new Uint8Array(digest));
  if (targetType && targetId) _pbRememberReceiptToken(targetType, targetId, receiptToken);
  return { receiptToken, receiptTokenHash };
}

window.PBReceiptTokens = Object.freeze({
  create: _pbCreateReceiptCredential,
  remember: _pbRememberReceiptToken,
  get: _pbGetReceiptToken,
  forget: _pbForgetReceiptToken,
});

async function _pbPrepareReceiptImage(file) {
  if (!file) throw new Error('Receipt screenshot is required.');
  const rawType = String(file.type || '').toLowerCase();
  const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  const directlySupported = ['image/jpeg', 'image/png', 'image/webp'].includes(type);
  const targetBytes = 1250 * 1024;

  if (Number(file.size || 0) <= targetBytes && directlySupported) {
    if (rawType === type) return file;
    try { return file.slice(0, file.size, type); } catch (_) { return file; }
  }

  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return file;
  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(file);
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The selected receipt image could not be decoded.'));
      element.src = objectUrl;
    });
    const maxDimension = 1800;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const encode = quality => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    let encoded = await encode(0.84);
    if (encoded?.size > targetBytes) encoded = await encode(0.72);
    return encoded?.size ? encoded : file;
  } catch (_) {
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function _pbFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected receipt.'));
    reader.readAsDataURL(file);
  });
}

async function _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile, authHeader) {
  const imageBase64 = await _pbFileToDataUrl(imageFile);
  const fallbackPayload = {
    action: 'verify',
    targetType: payload.targetType,
    provider: String(payload.provider || 'gcash'),
    receiptToken: String(payload.receiptToken || ''),
    contentType: imageFile.type || payload.contentType || 'image/jpeg',
    imageBase64,
    ...(payload.targetType === 'booking'
      ? { bookingRef: String(payload.bookingRef || '') }
      : { openPlayRegistrationId: String(payload.openPlayRegistrationId || '') }),
  };
  const response = await _pbFetchWithTimeout(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': authHeader,
    },
    body: JSON.stringify(fallbackPayload),
  }, PB_RECEIPT_TIMEOUT_MS);
  const text = await response.text();
  const json = _safeJsonParse(text);
  if (!response.ok) throw new Error(json?.error || text || `Receipt verification HTTP ${response.status}`);
  if (!json || json.ok !== true) throw new Error(json?.error || 'Receipt verification returned an invalid response.');
  return json;
}

// Initialize Supabase client (uses UMD global loaded from CDN)
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

const PB_IS_LOCAL_HOST = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const PB_DATA_MODE_KEY = 'pb_data_mode';

if (PB_IS_LOCAL_HOST) {
  const params = new URLSearchParams(location.search);
  if (['1', 'true', 'local'].includes((params.get('localData') || '').toLowerCase())) {
    localStorage.setItem(PB_DATA_MODE_KEY, 'local');
  }
  if (['1', 'true', 'remote'].includes((params.get('remoteData') || '').toLowerCase())) {
    localStorage.removeItem(PB_DATA_MODE_KEY);
  }
}

window.PB_USE_LOCAL_DATA = PB_IS_LOCAL_HOST && localStorage.getItem(PB_DATA_MODE_KEY) === 'local';

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

async function _pbAuthenticatedRestHeaders(extraHeaders = {}) {
  const { data, error } = await _sb.auth.getSession();
  if (error) throw error;
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error('Authentication required. Please sign in again.');
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    ...extraHeaders,
  };
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
    receiptUploadTokenHash: r.receipt_upload_token_hash || null,
    billedAt:      r.billed_at || null,
    weeklyFeeId:   r.weekly_fee_id || null,
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
    ...(b.receiptUploadTokenHash !== undefined
      ? { receipt_upload_token_hash: b.receiptUploadTokenHash || null }
      : {}),
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

// Privacy-safe public availability rows deliberately contain no customer,
// payment, receipt, or booking-reference fields.
function rowToBookingAvailability(r) {
  return {
    ref:       null,
    fullName:  null,
    courtId:   r.court_id,
    date:      r.date,
    slots:     r.slots || [],
    status:    r.status,
    createdAt: r.created_at,
  };
}

// Open Play session details are copied onto each registration so later config
// edits do not change the time or price the player originally selected.
function _openPlaySessionSnapshot(reg) {
  const snapshot = {};
  const fieldMap = [
    ['sessionKey',   'session_key'],
    ['sessionStart', 'session_start'],
    ['sessionEnd',   'session_end'],
    ['baseFee',      'base_fee'],
    ['systemFee',    'system_fee'],
    ['totalDue',     'total_due'],
  ];

  fieldMap.forEach(([jsKey, dbKey]) => {
    const value = reg[jsKey] !== undefined ? reg[jsKey] : reg[dbKey];
    if (value !== undefined && value !== null) snapshot[dbKey] = value;
  });
  return snapshot;
}

function _openPlaySessionStart(sessionKeyOrStart) {
  if (typeof sessionKeyOrStart === 'number' && Number.isFinite(sessionKeyOrStart)) {
    return sessionKeyOrStart;
  }
  if (sessionKeyOrStart && typeof sessionKeyOrStart === 'object') {
    const start = Number(sessionKeyOrStart.start ?? sessionKeyOrStart.sessionStart);
    return Number.isFinite(start) ? start : null;
  }
  if (typeof sessionKeyOrStart !== 'string') return null;

  const value = sessionKeyOrStart.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  // Admin-generated keys use op-<start>-<end>. Parsing the start lets new
  // session cards include pre-migration registrations that only stored `hour`.
  const keyMatch = value.match(/^op-(-?\d+(?:\.\d+)?)-/i);
  return keyMatch ? Number(keyMatch[1]) : null;
}

function _isMissingOpenPlaySessionColumn(error) {
  if (!error) return false;
  const details = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
  const mentionsSessionColumn = /session_key|session_start|session_end|base_fee|system_fee|total_due/.test(details);
  return mentionsSessionColumn && (error.code === 'PGRST204' || error.code === '42703' || /column|schema cache/.test(details));
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
    // Dashboard sessions need complete operational rows. Anonymous visitors
    // only receive the non-PII availability projection.
    let authenticated = false;
    try {
      const { data } = await _sb.auth.getSession();
      authenticated = Boolean(data?.session);
    } catch (_) {}
    const source = authenticated ? 'bookings' : 'booking_availability';
    const columns = authenticated ? '*' : 'court_id,date,slots,status,created_at';
    const { data, error } = await _sb.from(source).select(columns).order('created_at', { ascending: false });
    if (error) { console.error(`getBookings(${source}):`, error); return []; }
    return data.map(authenticated ? rowToBooking : rowToBookingAvailability);
  },

  async addBooking(booking) {
    // Check the privacy-safe projection for a friendly conflict message. The
    // database trigger remains the race-safe source of truth for the insert.
    const { data: existing } = await _sb
      .from('booking_availability')
      .select('court_id,date,slots,status,created_at')
      .eq('court_id', booking.courtId)
      .eq('date', booking.date)
      .neq('status', 'cancelled');

    if (existing) {
      const freshHoldCutoff = Date.now() - PB_PUBLIC_HOLD_MINUTES * 60 * 1000;
      const bookedSlots = new Set(existing
        // A verifying row is only a temporary public hold. Ignore it after the
        // same 15-minute window enforced by the database expiry trigger.
        .filter(b => {
          if (b.status !== 'verifying') return true;
          const createdAt = new Date(b.created_at || '').getTime();
          return !Number.isFinite(createdAt) || createdAt >= freshHoldCutoff;
        })
        .flatMap(b => b.slots || [])
        .map(String));
      const conflict = (booking.slots || []).some(s => bookedSlots.has(String(s)));
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
    if (updates.billedAt !== undefined) row.billed_at = updates.billedAt;
    if (updates.weeklyFeeId !== undefined) row.weekly_fee_id = updates.weeklyFeeId;
    const { error } = await _sb.from('bookings').update(row).eq('ref', ref);
    if (error) { console.error('updateBooking:', error); throw error; }
  },

  async finalizePublicBookingHold(ref, details) {
    const { data, error } = await _sb.rpc('finalize_public_booking_hold', {
      p_booking_ref: String(ref || ''),
      p_raw_token: String(details?.receiptToken || ''),
      p_full_name: String(details?.fullName || ''),
      p_contact_number: String(details?.contactNumber || ''),
      p_email: String(details?.email || ''),
      p_payment_method: String(details?.paymentMethod || 'cash'),
      p_payment_choice: details?.paymentChoice === 'full' ? 'full' : 'downpayment',
      p_payment_reference: details?.paymentReference || null,
    });
    if (error) { console.error('finalizePublicBookingHold:', error); throw error; }
    const finalized = Array.isArray(data) ? (data[0] || null) : data;
    const numericFieldsPresent = ['total_due', 'amount_due', 'duration'].every(key => {
      const value = finalized?.[key];
      return value !== null && value !== undefined
        && (typeof value !== 'string' || value.trim() !== '');
    });
    const totalDue = Number(finalized?.total_due);
    const amountDue = Number(finalized?.amount_due);
    const duration = Number(finalized?.duration);
    const slots = Array.isArray(finalized?.slots) ? finalized.slots.map(String) : [];
    if (!finalized?.booking_ref || !numericFieldsPresent
        || !Number.isFinite(totalDue) || totalDue < 0
        || !Number.isFinite(amountDue) || amountDue < 0 || amountDue > totalDue + 0.01
        || !Number.isInteger(duration) || duration < 1 || slots.length !== duration
        || !finalized?.court_name || !finalized?.start_time || !finalized?.end_time) {
      throw new Error('Booking finalization returned an incomplete authoritative price.');
    }
    return {
      bookingRef: finalized.booking_ref,
      bookingStatus: finalized.booking_status,
      bookingPaymentStatus: finalized.booking_payment_status,
      courtName: finalized.court_name,
      startTime: finalized.start_time,
      endTime: finalized.end_time,
      duration,
      slots,
      totalDue,
      amountDue,
    };
  },

  async cancelPublicBookingHold(ref, receiptToken) {
    const { data, error } = await _sb.rpc('cancel_public_booking_hold', {
      p_booking_ref: String(ref || ''),
      p_raw_token: String(receiptToken || ''),
    });
    if (error) { console.error('cancelPublicBookingHold:', error); throw error; }
    return Array.isArray(data) ? (data[0] || null) : data;
  },

  // Stamp a set of bookings as billed on a given weekly statement (idempotent
  // audit trail; a booking is only ever billed once).
  async markBookingsBilled(refs, weeklyFeeId) {
    if (!Array.isArray(refs) || refs.length === 0) return;
    const { error } = await _sb.from('bookings')
      .update({ billed_at: new Date().toISOString(), weekly_fee_id: weeklyFeeId })
      .in('ref', refs);
    if (error) { console.error('markBookingsBilled:', error); throw error; }
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
    // The RPC resolves the enabled session, capacity, and authoritative fee
    // snapshot server-side. Public browsers cannot manufacture price rows.
    const { data, error } = await _sb.rpc('create_public_open_play_registration', {
      p_full_name: String(reg.fullName || ''),
      p_court_id: String(reg.courtId || ''),
      p_date: reg.date,
      p_session_key: String(reg.sessionKey || ''),
      p_payment_type: String(reg.paymentType || ''),
      p_payment_method: String(reg.paymentMethod || 'cash'),
      p_payment_reference: reg.gcashRef || null,
      p_receipt_upload_token_hash: reg.receiptUploadTokenHash || null,
    });
    if (error) { console.error('addOpenPlayRegistration:', error); throw error; }
    const created = Array.isArray(data) ? (data[0] || null) : data;
    const numericFieldsPresent = [
      'total_due', 'amount_due', 'base_fee', 'system_fee',
      'session_start', 'session_end',
    ].every(key => {
      const value = created?.[key];
      return value !== null && value !== undefined
        && (typeof value !== 'string' || value.trim() !== '');
    });
    const totalDue = Number(created?.total_due);
    const amountDue = Number(created?.amount_due);
    const baseFee = Number(created?.base_fee);
    const systemFee = Number(created?.system_fee);
    const sessionStart = Number(created?.session_start);
    const sessionEnd = Number(created?.session_end);
    if (!created?.registration_id || !numericFieldsPresent
        || !Number.isFinite(totalDue) || totalDue < 0
        || !Number.isFinite(amountDue) || amountDue < 0 || amountDue > totalDue + 0.01
        || !Number.isFinite(baseFee) || baseFee < 0
        || !Number.isFinite(systemFee) || systemFee < 0
        || !Number.isInteger(sessionStart) || !Number.isInteger(sessionEnd)
        || sessionStart < 0 || sessionEnd > 24 || sessionEnd <= sessionStart) {
      throw new Error('Open Play registration returned an incomplete authoritative price.');
    }
    return {
      registrationId: created.registration_id,
      sessionKey: created.session_key,
      sessionStart,
      sessionEnd,
      baseFee,
      systemFee,
      totalDue,
      amountDue,
      paymentStatus: created.payment_status,
      receiptStatus: created.receipt_status,
    };
  },

  async updateOpenPlayRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef      !== undefined) row.gcash_ref      = updates.gcashRef;
    if (updates.receiptImageUrl !== undefined) row.receipt_image_url = updates.receiptImageUrl;
    if (updates.receiptImageHash !== undefined) row.receipt_image_hash = updates.receiptImageHash;
    if (updates.receiptPhash !== undefined) row.receipt_phash = updates.receiptPhash;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    const { error } = await _sb.from('open_play_registrations').update(row).eq('id', id);
    if (error) { console.error('updateOpenPlayRegistration:', error); throw error; }
  },

  async getOpenPlayCountForDate(date, courtId = null, sessionKeyOrStart = null) {
    const sessionStart = _openPlaySessionStart(sessionKeyOrStart);
    const sessionKey = typeof sessionKeyOrStart === 'string' ? sessionKeyOrStart.trim() : '';
    const { data, error } = await _sb.rpc('get_public_open_play_count', {
      p_date: date,
      p_court_id: courtId == null ? null : String(courtId),
      p_session_key: sessionKey || null,
      p_session_start: sessionStart,
    });
    if (error) {
      console.error('getOpenPlayCountForDate:', error);
      return 0;
    }
    const count = Number(data ?? 0);
    return Number.isFinite(count) ? count : 0;
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

  // Verify a receipt already bound to a persisted booking/registration.
  // payload: { targetType, bookingRef|openPlayRegistrationId, provider,
  //            receiptToken, imageFile }
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    const targetType = String(payload?.targetType || '');
    if (!['booking', 'open_play'].includes(targetType)) throw new Error('Invalid receipt target type.');
    if (targetType === 'booking' && !payload?.bookingRef) throw new Error('Booking reference is required.');
    if (targetType === 'open_play' && !payload?.openPlayRegistrationId) throw new Error('Open Play registration id is required.');
    if (!payload?.receiptToken) throw new Error('Receipt upload authorization is missing. Please restart the booking.');

    const imageFile = await _pbPrepareReceiptImage(payload.imageFile);
    if (!imageFile || Number(imageFile.size || 0) === 0) throw new Error('Receipt image is empty.');
    if (Number(imageFile.size || 0) > 5 * 1024 * 1024) throw new Error('Receipt image is too large (max 5 MB).');

    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const sess = await _sb.auth.getSession();
    const accessToken = sess?.data?.session?.access_token || '';
    const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

    const form = new FormData();
    form.append('action', 'verify');
    form.append('targetType', targetType);
    form.append('provider', String(payload.provider || 'gcash'));
    form.append('receiptToken', String(payload.receiptToken));
    form.append('contentType', String(imageFile.type || payload.contentType || 'image/jpeg'));
    if (targetType === 'booking') form.append('bookingRef', String(payload.bookingRef));
    else form.append('openPlayRegistrationId', String(payload.openPlayRegistrationId));
    try {
      form.append('receipt', imageFile, imageFile.name || 'receipt.jpg');
    } catch (_) {
      // Compatibility-only fallback for embedded browsers that reject a
      // file-like object in FormData. It reuses the same target and token.
      return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile, authHeader);
    }

    const res = await _pbFetchWithTimeout(fnUrl, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: form,
    }, PB_RECEIPT_TIMEOUT_MS);
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) {
      const reason = String(json?.error || txt || `Receipt verification HTTP ${res.status}`);
      const multipartDroppedImage = [400, 415, 422].includes(res.status) &&
        /receipt file|multipart body|empty image|image (?:is )?required/i.test(reason);
      if (multipartDroppedImage) {
        return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile, authHeader);
      }
      throw new Error(reason);
    }
    if (!json || json.ok !== true) throw new Error(json?.error || 'Receipt verification returned an invalid response.');
    return json;
  },

  // Authenticated dashboard confirmation. This atomically claims the
  // provider-scoped reference ledger and advances the payment/receipt state.
  async manualApproveReceipt(targetType, targetKey, provider, paymentReference) {
    const type = String(targetType || '');
    if (!['booking', 'open_play'].includes(type)) throw new Error('Invalid receipt target type.');
    const { data, error } = await _sb.rpc('manual_approve_receipt', {
      p_target_type: type,
      p_target_key: String(targetKey || ''),
      p_provider: String(provider || ''),
      p_payment_reference: String(paymentReference || ''),
    });
    if (error) { console.error('manualApproveReceipt:', error); throw error; }
    const approved = Array.isArray(data) ? (data[0] || null) : data;
    if (!approved?.target_key) throw new Error('Payment confirmation returned an incomplete response.');
    return approved;
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

  async getOpenPlayReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', openPlayRegistrationId: registrationId },
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

  // ---- WEEKLY BILLING (system owner) ----
  async getWeeklyFees() {
    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?order=week_start.desc,created_at.desc`, {
        headers: await _pbAuthenticatedRestHeaders(),
      });
      if (!res.ok) {
        console.error('getWeeklyFees REST error:', res.status, res.statusText);
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error('getWeeklyFees:', err);
      return [];
    }
  },

  async saveWeeklyFee(statement) {
    const row = {
      court_owner_user_id: statement.courtOwnerUserId,
      court_owner_email: statement.courtOwnerEmail || null,
      week_start: statement.weekStart,
      week_end: statement.weekEnd,
      bookings_count: statement.bookingsCount || 0,
      fee_per_booking: statement.feePerBooking,
      amount_due: statement.amountDue,
      billed_refs: statement.billedRefs || [],
      status: statement.status || 'sent',
      generated_at: statement.generatedAt || new Date().toISOString(),
      due_at: statement.dueAt || null,
      sent_at: statement.sentAt || null,
      paid_at: statement.paidAt || null,
      paid_ref: statement.paidRef || null,
      paid_note: statement.paidNote || null,
      paid_by_user_id: statement.paidByUserId || null,
    };

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees`, {
        method: 'POST',
        headers: await _pbAuthenticatedRestHeaders({
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('saveWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.error('saveWeeklyFee:', err);
      throw err;
    }
  },

  async updateWeeklyFee(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.paidRef !== undefined) row.paid_ref = updates.paidRef;
    if (updates.paidNote !== undefined) row.paid_note = updates.paidNote;
    if (updates.paidByUserId !== undefined) row.paid_by_user_id = updates.paidByUserId;
    if (updates.sentAt !== undefined) row.sent_at = updates.sentAt;
    if (updates.dueAt !== undefined) row.due_at = updates.dueAt;
    if (updates.bookingsCount !== undefined) row.bookings_count = updates.bookingsCount;
    if (updates.amountDue !== undefined) row.amount_due = updates.amountDue;
    if (updates.feePerBooking !== undefined) row.fee_per_booking = updates.feePerBooking;
    if (updates.billedRefs !== undefined) row.billed_refs = updates.billedRefs;
    if (updates.generatedAt !== undefined) row.generated_at = updates.generatedAt;

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _pbAuthenticatedRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('updateWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('updateWeeklyFee:', err);
      throw err;
    }
  },

  // Court owner submits a payment proof for their statement
  async submitWeeklyFeePayment(id, { submittedRef, submittedNote, submittedProofUrl }) {
    try {
      const { data, error } = await _sb.rpc('submit_weekly_fee_payment', {
        p_fee_id: id,
        p_submitted_ref: submittedRef || '',
        p_submitted_note: submittedNote || null,
        p_submitted_proof_url: submittedProofUrl || null,
      });
      if (error) throw error;
      const submitted = Array.isArray(data) ? (data[0] || null) : data;
      if (!submitted?.fee_id) throw new Error('Payment submission returned an incomplete response.');
      return submitted;
    } catch (err) {
      console.error('submitWeeklyFeePayment:', err);
      throw err;
    }
  },
};

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
// =============================================
// LOCAL DATA MODE
// Enable only on localhost with localStorage.setItem('pb_data_mode', 'local')
// or by opening a local page with ?localData=1. Disable with ?remoteData=1.
// =============================================
(function installLocalDataMode() {
  if (!window.PB_USE_LOCAL_DATA) return;

  const STORE_KEY = 'pb_local_db_v1';
  const nowIso = () => new Date().toISOString();
  const localRef = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

  const defaultCourts = () => Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return {
      id: `c${n}`,
      name: n === 1 ? 'CourtYard Pickleball' : `Court ${n}`,
      desc: 'Outdoor',
      rate: n <= 5 ? 60 : 90,
      blocked: false,
      feats: ['Outdoor'],
      photo: '',
      rateSchedule: [
        { from: 6, to: 18, rate: 60 },
        { from: 18, to: 23, rate: 90 },
      ],
    };
  });

  const defaultSettings = () => ({
    open_hour: '6',
    close_hour: '23',
    open_play_config: JSON.stringify({
      enabled: true,
      start: 6,
      end: 23,
      days: [0, 6],
      specificDates: ['2026-06-20'],
      courtIds: [],
      fee: 25,
      maxPlayers: 16,
      sessions: [
        { key: 'op-6-23', name: 'Weekend Open Play', start: 6, end: 23, fee: 25, maxPlayers: 16 },
      ],
    }),
    payment_acceptance_mode: 'full_payment_only',
    payment_method_cash: '0',
    payment_method_gcash: '1',
    payment_method_gotyme: '0',
    payment_method_pnb: '0',
    gcash_merchant_number: '09524825766',
    gcash_merchant_name: 'Annaliza M. Acero',
    service_fee_rate: '15',
    maintenance_fee: '5',
    fee_type: 'booking',
  });

  const defaultAccounts = () => ([{
    id: 'owner_001',
    username: 'developer',
    password: 'dev123',
    role: 'owner',
    fullName: 'System Owner',
    email: 'owner@courtyardpickleball.com',
    createdAt: nowIso(),
  }]);

  function freshDb() {
    return {
      courts: defaultCourts(),
      bookings: [],
      openPlayRegistrations: [],
      blockedDates: [],
      accounts: defaultAccounts(),
      settings: defaultSettings(),
      agreements: [],
      weeklyFees: [],
    };
  }

  function readDb() {
    const parsed = _safeJsonParse(localStorage.getItem(STORE_KEY));
    if (!parsed || typeof parsed !== 'object') {
      const db = freshDb();
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      return db;
    }
    return {
      ...freshDb(),
      ...parsed,
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      courts: Array.isArray(parsed.courts) && parsed.courts.length ? parsed.courts : defaultCourts(),
      bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
      openPlayRegistrations: Array.isArray(parsed.openPlayRegistrations) ? parsed.openPlayRegistrations : [],
      blockedDates: Array.isArray(parsed.blockedDates) ? parsed.blockedDates : [],
      accounts: Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : defaultAccounts(),
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      weeklyFees: Array.isArray(parsed.weeklyFees) ? parsed.weeklyFees : [],
    };
  }

  function writeDb(db) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  window.DB = {
    async getCourts() { return readDb().courts; },
    async saveCourt(court) {
      const db = readDb();
      const row = { ...court, id: String(court.id || localRef('court')).toLowerCase() };
      const idx = db.courts.findIndex(c => String(c.id) === String(row.id));
      if (idx >= 0) db.courts[idx] = { ...db.courts[idx], ...row };
      else db.courts.push(row);
      writeDb(db);
    },
    async deleteCourt(id) {
      const db = readDb();
      db.courts = db.courts.filter(c => String(c.id) !== String(id));
      writeDb(db);
    },

    async getBookings() {
      return readDb().bookings.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async addBooking(booking) {
      const db = readDb();
      const freshHoldCutoff = Date.now() - PB_PUBLIC_HOLD_MINUTES * 60 * 1000;
      const bookedSlots = new Set(db.bookings
        .filter(b => {
          if (String(b.courtId) !== String(booking.courtId) || b.date !== booking.date || b.status === 'cancelled') return false;
          if (b.status !== 'verifying') return true;
          const createdAt = new Date(b.createdAt || '').getTime();
          return !Number.isFinite(createdAt) || createdAt >= freshHoldCutoff;
        })
        .flatMap(b => b.slots || [])
        .map(String));
      const conflict = (booking.slots || []).some(s => bookedSlots.has(String(s)));
      if (conflict) throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
      db.bookings.push({ ...booking, ref: booking.ref || localRef('PB'), createdAt: booking.createdAt || nowIso() });
      writeDb(db);
    },
    async getBookingByRef(ref) { return readDb().bookings.find(b => String(b.ref) === String(ref)) || null; },
    async updateBooking(ref, updates) {
      const db = readDb();
      db.bookings = db.bookings.map(b => String(b.ref) === String(ref) ? { ...b, ...updates } : b);
      writeDb(db);
    },
    async finalizePublicBookingHold(ref, details) {
      const db = readDb();
      let result = null;
      db.bookings = db.bookings.map(booking => {
        if (String(booking.ref) !== String(ref)) return booking;
        const paymentMethod = details?.paymentMethod || 'cash';
        const total = Number(booking.total || 0);
        const downpayment = details?.paymentChoice === 'full' ? total : total / 2;
        const updated = {
          ...booking,
          fullName: details?.fullName || booking.fullName,
          contactNumber: details?.contactNumber || booking.contactNumber,
          email: details?.email || booking.email,
          paymentMethod,
          paymentFlow: paymentMethod,
          gcashRef: details?.paymentReference || null,
          downpayment,
          paymentStatus: paymentMethod === 'cash' ? 'unpaid' : 'for_verification',
          status: paymentMethod === 'cash' ? 'pending' : 'verifying',
        };
        result = {
          bookingRef: updated.ref,
          bookingStatus: updated.status,
          bookingPaymentStatus: updated.paymentStatus,
          courtName: updated.courtName,
          startTime: updated.startTime,
          endTime: updated.endTime,
          duration: Number(updated.duration || 0),
          slots: Array.isArray(updated.slots) ? updated.slots.map(String) : [],
          totalDue: total,
          amountDue: downpayment,
        };
        return updated;
      });
      writeDb(db);
      return result;
    },
    async cancelPublicBookingHold(ref) {
      const db = readDb();
      let result = null;
      db.bookings = db.bookings.map(booking => {
        if (String(booking.ref) !== String(ref)) return booking;
        const updated = { ...booking, status: 'cancelled', paymentStatus: 'rejected' };
        result = {
          booking_ref: updated.ref,
          booking_status: updated.status,
          booking_payment_status: updated.paymentStatus,
        };
        return updated;
      });
      writeDb(db);
      return result;
    },
    async markBookingsBilled(refs, weeklyFeeId) {
      if (!Array.isArray(refs) || refs.length === 0) return;
      const db = readDb();
      db.bookings = db.bookings.map(b => refs.includes(b.ref) ? { ...b, billedAt: nowIso(), weeklyFeeId } : b);
      writeDb(db);
    },
    async deleteBooking(ref) {
      const db = readDb();
      db.bookings = db.bookings.filter(b => String(b.ref) !== String(ref));
      writeDb(db);
    },

    async getOpenPlayRegistrations() {
      return readDb().openPlayRegistrations.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    },
    async addOpenPlayRegistration(reg) {
      const db = readDb();
      const id = localRef('op');
      db.openPlayRegistrations.push({
        id,
        full_name: reg.fullName,
        court_id: String(reg.courtId),
        court_name: reg.courtName,
        date: reg.date,
        hour: reg.hour ?? reg.sessionStart,
        time_label: reg.timeLabel,
        payment_type: reg.paymentType,
        payment_method: reg.paymentMethod || 'cash',
        gcash_ref: reg.gcashRef || null,
        payment_status: 'pending',
        amount: reg.amount,
        receipt_status: 'none',
        receipt_upload_token_hash: reg.receiptUploadTokenHash || null,
        ..._openPlaySessionSnapshot(reg),
        created_at: nowIso(),
      });
      writeDb(db);
      return {
        registrationId: id,
        sessionKey: reg.sessionKey,
        sessionStart: Number(reg.sessionStart ?? reg.hour),
        sessionEnd: Number(reg.sessionEnd),
        baseFee: Number(reg.baseFee || 0),
        systemFee: Number(reg.systemFee || 0),
        totalDue: Number(reg.totalDue || 0),
        amountDue: Number(reg.amount || 0),
        paymentStatus: 'pending',
        receiptStatus: 'none',
      };
    },
    async updateOpenPlayRegistration(id, updates) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.map(r => {
        if (String(r.id) !== String(id)) return r;
        return {
          ...r,
          payment_status: updates.paymentStatus !== undefined ? updates.paymentStatus : r.payment_status,
          gcash_ref: updates.gcashRef !== undefined ? updates.gcashRef : r.gcash_ref,
          receipt_image_url: updates.receiptImageUrl !== undefined ? updates.receiptImageUrl : r.receipt_image_url,
          receipt_image_hash: updates.receiptImageHash !== undefined ? updates.receiptImageHash : r.receipt_image_hash,
          receipt_phash: updates.receiptPhash !== undefined ? updates.receiptPhash : r.receipt_phash,
          receipt_status: updates.receiptStatus !== undefined ? updates.receiptStatus : r.receipt_status,
          receipt_flags: updates.receiptFlags !== undefined ? updates.receiptFlags : r.receipt_flags,
          receipt_extracted: updates.receiptExtracted !== undefined ? updates.receiptExtracted : r.receipt_extracted,
          receipt_confidence: updates.receiptConfidence !== undefined ? updates.receiptConfidence : r.receipt_confidence,
          receipt_verified_at: updates.receiptVerifiedAt !== undefined ? updates.receiptVerifiedAt : r.receipt_verified_at,
        };
      });
      writeDb(db);
    },
    async manualApproveReceipt(targetType, targetKey, provider, paymentReference) {
      const type = String(targetType || '');
      const providerKey = String(provider || '').trim().toLowerCase();
      const normalizeReference = value => providerKey === 'gcash'
        ? String(value || '').replace(/\D/g, '')
        : String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const normalizedReference = normalizeReference(paymentReference);
      if (!['booking', 'open_play'].includes(type) || !providerKey || !normalizedReference) {
        throw new Error('A valid receipt target, provider, and payment reference are required.');
      }

      const db = readDb();
      const claims = [
        ...db.bookings.map(b => ({
          owner: `booking:${b.ref}`,
          provider: String(b.paymentProvider || b.paymentMethod || '').trim().toLowerCase(),
          reference: b.gcashRef,
          status: b.receiptStatus,
        })),
        ...db.openPlayRegistrations.map(r => ({
          owner: `open_play:${r.id}`,
          provider: String(r.payment_provider || r.payment_method || '').trim().toLowerCase(),
          reference: r.gcash_ref,
          status: r.receipt_status,
        })),
      ];
      const owner = `${type}:${targetKey}`;
      const duplicate = claims.some(claim => {
        if (claim.owner === owner || claim.status !== 'manual_approved' || claim.provider !== providerKey) return false;
        return normalizeReference(claim.reference) === normalizedReference;
      });
      if (duplicate) throw new Error('This payment reference is already confirmed for another registration.');

      let paymentStatus = 'paid';
      let bookingStatus = null;
      if (type === 'booking') {
        const index = db.bookings.findIndex(b => String(b.ref) === String(targetKey));
        if (index < 0) throw new Error('Booking not found.');
        const booking = db.bookings[index];
        paymentStatus = Number(booking.downpayment || 0) >= Number(booking.total || 0)
          ? 'paid'
          : 'downpayment_paid';
        bookingStatus = 'confirmed';
        db.bookings[index] = {
          ...booking,
          status: bookingStatus,
          paymentStatus,
          paymentProvider: providerKey,
          gcashRef: paymentReference,
          receiptStatus: 'manual_approved',
          receiptVerifiedAt: nowIso(),
        };
      } else {
        const index = db.openPlayRegistrations.findIndex(r => String(r.id) === String(targetKey));
        if (index < 0) throw new Error('Open Play registration not found.');
        db.openPlayRegistrations[index] = {
          ...db.openPlayRegistrations[index],
          payment_status: 'paid',
          payment_provider: providerKey,
          gcash_ref: paymentReference,
          receipt_status: 'manual_approved',
          receipt_verified_at: nowIso(),
        };
      }
      writeDb(db);
      return {
        target_type: type,
        target_key: String(targetKey),
        payment_status: paymentStatus,
        booking_status: bookingStatus,
        receipt_status: 'manual_approved',
        provider: providerKey,
        normalized_reference: normalizedReference,
        ledger_key: `${providerKey}:${normalizedReference}`,
      };
    },
    async getOpenPlayCountForDate(date, courtId = null, sessionKeyOrStart = null) {
      const sessionStart = _openPlaySessionStart(sessionKeyOrStart);
      const sessionKey = typeof sessionKeyOrStart === 'string' ? sessionKeyOrStart.trim() : '';
      return readDb().openPlayRegistrations.filter(r =>
        r.date === date &&
        (!courtId || String(r.court_id) === String(courtId)) &&
        (sessionStart !== null
          ? Number(r.hour ?? r.session_start) === sessionStart
          : (!sessionKey || r.session_key === sessionKey)) &&
        r.payment_status !== 'rejected'
      ).length;
    },
    async deleteOpenPlayRegistration(id) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.filter(r => String(r.id) !== String(id));
      writeDb(db);
    },

    async getBlockedDates() { return readDb().blockedDates; },
    async addBlockedDate(date) {
      const db = readDb();
      if (!db.blockedDates.includes(date)) db.blockedDates.push(date);
      db.blockedDates.sort();
      writeDb(db);
    },
    async removeBlockedDate(date) {
      const db = readDb();
      db.blockedDates = db.blockedDates.filter(d => d !== date);
      writeDb(db);
    },

    async getAccounts() { return readDb().accounts; },
    async saveAccount(account) {
      const db = readDb();
      const idx = db.accounts.findIndex(a => String(a.id) === String(account.id));
      if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...account };
      else db.accounts.push({ ...account, id: account.id || localRef('acc'), createdAt: account.createdAt || nowIso() });
      writeDb(db);
    },
    async deleteAccount(id) {
      const db = readDb();
      db.accounts = db.accounts.filter(a => String(a.id) !== String(id));
      writeDb(db);
    },

    async getSettings() { return readDb().settings; },
    async saveSetting(key, value) {
      const db = readDb();
      db.settings[key] = value;
      writeDb(db);
    },

    async createPaymentSession() { throw new Error('Online checkout is disabled in local data mode.'); },
    async verifyGcashReceipt() {
      return { ok: true, status: 'manual_review', flags: ['local_data_mode'], extracted: {}, confidence: 0, message: 'Local data mode: receipt OCR is not sent to Supabase.' };
    },
    async getReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },
    async getOpenPlayReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },

    async seedDefaultData() { readDb(); },
    async getAgreement(userId, version = 1) {
      return readDb().agreements.find(a => String(a.userId) === String(userId) && Number(a.version) === Number(version)) || null;
    },
    async saveAgreement(data) {
      const db = readDb();
      const version = data.version || 1;
      const idx = db.agreements.findIndex(a => String(a.userId) === String(data.userId) && Number(a.version || 1) === Number(version));
      const row = { ...data, version, agreedAt: nowIso() };
      if (idx >= 0) db.agreements[idx] = row;
      else db.agreements.push(row);
      writeDb(db);
    },
    async getWeeklyFees() { return readDb().weeklyFees; },
    async saveWeeklyFee(statement) {
      const db = readDb();
      const row = { ...statement, id: statement.id || localRef('fee'), generatedAt: statement.generatedAt || nowIso() };
      db.weeklyFees.unshift(row);
      writeDb(db);
      return row;
    },
    async updateWeeklyFee(id, updates) {
      const db = readDb();
      db.weeklyFees = db.weeklyFees.map(f => String(f.id) === String(id) ? { ...f, ...updates } : f);
      writeDb(db);
    },
    async submitWeeklyFeePayment(id, data) {
      await this.updateWeeklyFee(id, { ...data, status: 'submitted', submittedAt: nowIso() });
    },
  };

  window.PB_RESET_LOCAL_DATA = function resetLocalData() {
    localStorage.removeItem(STORE_KEY);
    return readDb();
  };

  console.info('[CourtYard] Local data mode enabled. Supabase writes are bypassed in this browser.');
})();

window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payments, open play)
  ROLES: ['owner', 'court_owner', 'staff'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'bookings', 'reports', 'courts', 'open_play', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'bookings', 'reports', 'courts', 'open_play', 'maintenance', 'payments', 'export', 'settings', 'court_owner_only'],
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

    // The Auth identity is not authorization by itself. It must be linked to
    // the exact accounts row owned by that auth UUID; never synthesize a staff
    // profile for an unprovisioned Supabase user.
    const { data: acc, error: profileError } = await _sb
      .from('accounts')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();
    if (profileError || !acc || !this.ROLES.includes(acc.role)) {
      try { await _sb.auth.signOut(); } catch (_) {}
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      localStorage.removeItem('pb_remember');
      return {
        ok: false,
        msg: profileError
          ? 'Could not verify your account profile. Please try again.'
          : 'This login is not linked to an authorized staff account.',
      };
    }
    const session = { ...rowToAccount(acc), loginAt: new Date().toISOString() };

    // Use localStorage when "remember me" is checked so session survives browser close
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    localStorage.removeItem('pb_remember');
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

    // Provision through a separate, in-memory auth client. Calling signUp on
    // the main `_sb` client would replace the currently signed-in owner's
    // session when email confirmation is disabled.
    let provisioningClient = null;
    try {
      provisioningClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: `pb_account_provisioning_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        },
      });
      const { data, error } = await provisioningClient.auth.signUp({
        email: d.email,
        password: d.password,
      });
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
      // DB.saveAccount deliberately uses the owner's main `_sb` client and its
      // authorization; the newly created user's session cannot write roles.
      try {
        await DB.saveAccount(acc);
        return { ok: true };
      } catch (error) {
        console.error('Auth.add profile save failed:', error);
        return { ok: false, msg: 'Auth user created but profile save failed. Ask the system owner to reconcile this account.' };
      }
    } catch (error) {
      console.error('Auth.add provisioning failed:', error);
      return { ok: false, msg: error?.message || 'Could not create the authentication user.' };
    } finally {
      // Discard any new-user session held by the isolated client. With
      // persistSession disabled, no provisioning credentials reach storage.
      if (provisioningClient) {
        try { await provisioningClient.auth.signOut(); } catch (_) {}
      }
    }
  },

  async update(id, d) {
    const all = await DB.getAccounts();
    const existing = all.find(x => x.id === id);
    if (!existing) return { ok: false };
    try { await DB.saveAccount({ ...existing, ...d }); return { ok: true }; }
    catch(e) { return { ok: false }; }
  },

  // Self-service password change for the currently signed-in user.
  // Verifies the current password first, then updates Supabase Auth (the source
  // of truth for login). Any signed-in role (owner / court_owner / staff) can use it.
  async changePassword(currentPassword, newPassword) {
    const sess = this.getSession();
    if (!sess || !sess.email) return { ok: false, msg: 'No active session. Please sign in again.' };
    if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };

    // Re-authenticate to confirm the current password is correct.
    const { error: authErr } = await _sb.auth.signInWithPassword({ email: sess.email, password: currentPassword });
    if (authErr) return { ok: false, msg: 'Current password is incorrect.' };

    // Update the password in Supabase Auth.
    const { error: updErr } = await _sb.auth.updateUser({ password: newPassword });
    if (updErr) return { ok: false, msg: updErr.message || 'Could not update password.' };

    return { ok: true };
  },

  async del(id) {
    await DB.deleteAccount(id);
    return { ok: true };
  },
};

if (window.PB_USE_LOCAL_DATA) {
  Object.assign(window.Auth, {
    async login(usernameOrEmail, password, remember = false) {
      const accounts = await DB.getAccounts();
      const user = accounts.find(a =>
        (a.username === usernameOrEmail || a.email === usernameOrEmail) &&
        (!a.password || a.password === password)
      );
      if (!user) return { ok: false };
      const session = { ...user, loginAt: new Date().toISOString(), isLocalData: true };
      const store = remember ? localStorage : sessionStorage;
      store.setItem('pb_session', JSON.stringify(session));
      if (remember) localStorage.setItem('pb_remember', '1');
      return { ok: true };
    },

    async logout() {
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      localStorage.removeItem('pb_remember');
      window.location.href = 'login.html';
    },

    async add(d) {
      const all = await DB.getAccounts();
      if (all.find(x => x.username === d.username || x.email === d.email)) return { ok: false, msg: 'Username or email already exists.' };
      const acc = {
        id: `local_${Date.now().toString(36)}`,
        fullName: d.fullName,
        username: d.username,
        password: d.password,
        email: d.email,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        createdAt: new Date().toISOString(),
      };
      await DB.saveAccount(acc);
      return { ok: true };
    },

    async changePassword(currentPassword, newPassword) {
      const sess = this.getSession();
      if (!sess) return { ok: false, msg: 'No active session. Please sign in again.' };
      const accounts = await DB.getAccounts();
      const user = accounts.find(a => String(a.id) === String(sess.id));
      if (user?.password && user.password !== currentPassword) return { ok: false, msg: 'Current password is incorrect.' };
      if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };
      await DB.saveAccount({ ...user, password: newPassword });
      return { ok: true };
    },
  });
}
