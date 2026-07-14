export type SettingsMap = Record<string, string>;

export type RateTier = {
  from: unknown;
  to: unknown;
  rate: unknown;
};

export type ExpectedPayment = {
  total: number;
  due: number;
  fullyPaid: boolean;
  snapshotMismatch: boolean;
  detail: Record<string, unknown>;
};

export function toFiniteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function moneyEquals(left: unknown, right: unknown): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01;
}

export function parseRateTiers(value: unknown): RateTier[] {
  if (Array.isArray(value)) return value as RateTier[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as RateTier[] : [];
  } catch {
    return [];
  }
}

function tierRate(hour: number, tiers: RateTier[], fallback: number): number {
  for (const tier of tiers) {
    const from = toFiniteNumber(tier.from, Number.NaN);
    const to = toFiniteNumber(tier.to, Number.NaN);
    const rate = toFiniteNumber(tier.rate, Number.NaN);
    if (![from, to, rate].every(Number.isFinite) || rate < 0) continue;
    const matches = from < to
      ? hour >= from && hour < to
      : hour >= from || hour < to;
    if (matches) return rate;
  }
  return fallback;
}

function isFlatFee(value: unknown): boolean {
  // Keep this contract identical to the public checkout's calcSvcFee(): only
  // the persisted literal `flat` is per-booking; every other value is hourly.
  return String(value || "").toLowerCase() === "flat";
}

function chooseDue(
  total: number,
  storedDue: unknown,
  acceptanceMode: unknown,
): number {
  const half = roundMoney(total / 2);
  const mode = String(acceptanceMode || "both").toLowerCase();
  if (mode === "full_payment_only") {
    if (!moneyEquals(storedDue, total)) {
      throw new Error("Stored payment is not the required full amount");
    }
    return total;
  }
  if (mode === "downpayment_only") {
    if (!moneyEquals(storedDue, half)) {
      throw new Error("Stored payment is not the required downpayment");
    }
    return half;
  }
  if (moneyEquals(storedDue, total)) return total;
  if (moneyEquals(storedDue, half)) return half;
  throw new Error(
    "Stored payment does not match an allowed server-derived amount",
  );
}

export function deriveCourtPayment(input: {
  slots: unknown;
  courtRate: unknown;
  courtRateSchedule?: unknown;
  fallbackRateSchedule?: unknown;
  serviceFeeRate?: unknown;
  feeType?: unknown;
  storedDue: unknown;
  storedTotal?: unknown;
  acceptanceMode?: unknown;
}): ExpectedPayment {
  const slots = Array.isArray(input.slots)
    ? input.slots.map(Number).filter((hour) =>
      Number.isFinite(hour) && hour >= 0 && hour < 24
    )
    : [];
  if (slots.length === 0) throw new Error("Booking has no billable slots");

  const fallbackRate = toFiniteNumber(input.courtRate, Number.NaN);
  if (!Number.isFinite(fallbackRate) || fallbackRate < 0) {
    throw new Error("Court rate is invalid");
  }
  const courtTiers = parseRateTiers(input.courtRateSchedule);
  const globalTiers = parseRateTiers(input.fallbackRateSchedule);
  const tiers = courtTiers.length ? courtTiers : globalTiers;
  const courtTotal = roundMoney(
    slots.reduce((sum, hour) => sum + tierRate(hour, tiers, fallbackRate), 0),
  );
  const serviceFeeRate = toFiniteNumber(input.serviceFeeRate);
  if (serviceFeeRate < 0) throw new Error("Service fee is invalid");
  const serviceFee = roundMoney(
    isFlatFee(input.feeType) ? serviceFeeRate : serviceFeeRate * slots.length,
  );
  const total = roundMoney(courtTotal + serviceFee);
  const due = chooseDue(total, input.storedDue, input.acceptanceMode);
  return {
    total,
    due,
    fullyPaid: moneyEquals(due, total),
    snapshotMismatch: input.storedTotal != null &&
      !moneyEquals(input.storedTotal, total),
    detail: { courtTotal, serviceFee, slots: [...slots].sort((a, b) => a - b) },
  };
}

type OpenPlaySession = {
  key: string;
  start: number;
  end: number;
  fee: number;
};

function sessionKey(session: Record<string, unknown>, index: number): string {
  const persisted = String(session.key || session.id || "").trim();
  if (persisted) return persisted;
  const start = Number(session.start);
  const end = Number(session.end);
  return Number.isFinite(start) && Number.isFinite(end)
    ? `op-${start}-${end}`
    : `op-session-${index + 1}`;
}

function normalizeOpenPlayConfig(raw: unknown): {
  config: Record<string, unknown>;
  sessions: OpenPlaySession[];
} {
  let config: Record<string, unknown>;
  try {
    config = typeof raw === "string"
      ? JSON.parse(raw)
      : raw as Record<string, unknown>;
  } catch {
    throw new Error("Open Play configuration is invalid JSON");
  }
  if (!config || typeof config !== "object") {
    throw new Error("Open Play configuration is missing");
  }
  if (config.enabled === false) throw new Error("Open Play is disabled");

  const legacyFee = toFiniteNumber(config.fee, 100);
  const source = Array.isArray(config.sessions) && config.sessions.length > 0
    ? config.sessions as Record<string, unknown>[]
    : [{ start: config.start, end: config.end, fee: legacyFee }];
  const sessions = source.map((session, index) => ({
    key: sessionKey(session, index),
    start: toFiniteNumber(session.start, Number.NaN),
    end: toFiniteNumber(session.end, Number.NaN),
    fee: toFiniteNumber(session.fee, legacyFee),
  })).filter((session) =>
    Number.isFinite(session.start) && Number.isFinite(session.end) &&
    session.end > session.start && Number.isFinite(session.fee) &&
    session.fee >= 0
  );
  if (sessions.length === 0) {
    throw new Error("Open Play has no valid session pricing");
  }
  return { config, sessions };
}

function openPlayDateAllowed(
  config: Record<string, unknown>,
  date: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const specificDates = Array.isArray(config.specificDates)
    ? config.specificDates.map(String)
    : [];
  const days = Array.isArray(config.days)
    ? config.days.map(Number).filter(Number.isInteger)
    : [];
  if (specificDates.includes(date)) return true;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return days.includes(day);
}

export function deriveOpenPlayPayment(input: {
  registration: Record<string, unknown>;
  settings: SettingsMap;
}): ExpectedPayment {
  const row = input.registration;
  const { config, sessions } = normalizeOpenPlayConfig(
    input.settings.open_play_config,
  );
  const date = String(row.date || "");
  if (!openPlayDateAllowed(config, date)) {
    throw new Error("Registration date is not configured for Open Play");
  }

  const configuredCourts = Array.isArray(config.courtIds)
    ? config.courtIds.map(String).filter(Boolean)
    : [];
  const courtId = String(row.court_id || "");
  if (configuredCourts.length > 0 && !configuredCourts.includes(courtId)) {
    throw new Error("Registration court is not configured for Open Play");
  }

  const wantedKey = String(row.session_key || "");
  const wantedStart = toFiniteNumber(row.session_start ?? row.hour, Number.NaN);
  const wantedEnd = toFiniteNumber(row.session_end, Number.NaN);
  const session =
    sessions.find((candidate) => wantedKey && candidate.key === wantedKey) ||
    sessions.find((candidate) =>
      Number.isFinite(wantedStart) && candidate.start === wantedStart &&
      (!Number.isFinite(wantedEnd) || candidate.end === wantedEnd)
    );
  if (!session) {
    throw new Error(
      "Registration does not match a configured Open Play session",
    );
  }

  // CourtYard charges the system/maintenance fee once per Open Play signup,
  // independent of the session duration.
  const systemFee = toFiniteNumber(
    input.settings.maintenance_fee ?? input.settings.service_fee_rate ??
      input.settings.booking_fee,
  );
  if (systemFee < 0) throw new Error("Open Play system fee is invalid");
  const total = roundMoney(session.fee + systemFee);
  const due = chooseDue(
    total,
    row.amount,
    input.settings.payment_acceptance_mode,
  );
  const snapshotMismatch = [
    row.base_fee == null || moneyEquals(row.base_fee, session.fee),
    row.system_fee == null || moneyEquals(row.system_fee, systemFee),
    row.total_due == null || moneyEquals(row.total_due, total),
  ].some((matches) => !matches);

  return {
    total,
    due,
    fullyPaid: moneyEquals(due, total),
    snapshotMismatch,
    detail: {
      sessionKey: session.key,
      sessionStart: session.start,
      sessionEnd: session.end,
      baseFee: session.fee,
      systemFee,
    },
  };
}
