export type PaymentProvider = "gcash" | "gotyme" | "pnb";

export type ReceiptDateTime = {
  date: string | null;
  wallTime: string | null;
  instant: Date | null;
  // A UTC-backed representation of the Philippine wall clock used only for
  // comparing it with the similarly shifted booking creation timestamp.
  shifted: Date | null;
};

export type AmountExtraction = {
  amount: number | null;
  reliable: boolean;
  ambiguous: boolean;
  reason: string;
  evidence: string[];
};

export type RecipientCheck = {
  status: "match" | "wrong" | "unreadable";
  numberStatus: "match" | "wrong" | "unreadable";
  nameStatus: "match" | "mismatch" | "unreadable";
  evidence: string[];
};

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function normalizeProvider(value: unknown): PaymentProvider | null {
  const provider = String(value || "").toLowerCase().replace(/[\s_-]/g, "");
  if (provider === "gcash") return "gcash";
  if (provider === "gotyme") return "gotyme";
  if (provider === "pnb") return "pnb";
  return null;
}

export function digitsOnly(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeReference(
  value: unknown,
  provider: PaymentProvider,
): string {
  const raw = String(value || "");
  return provider === "gcash"
    ? digitsOnly(raw)
    : raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isReferenceFormatValid(
  reference: string,
  provider: PaymentProvider,
): boolean {
  const normalized = normalizeReference(reference, provider);
  if (provider === "gcash") return /^\d{13}$/.test(normalized);
  return /^[A-Z0-9]{6,40}$/.test(normalized);
}

function normalizedAlphaNumeric(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function extractReference(
  text: string,
  provider: PaymentProvider,
  expectedReference = "",
): string | null {
  const expected = normalizeReference(expectedReference, provider);
  const normalizedText = normalizedAlphaNumeric(text);
  if (expected.length >= 6 && normalizedText.includes(expected)) {
    return expected;
  }

  const labelledPatterns = [
    /\b(?:reference|ref)\s*(?:id|no|number|#)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\s-]{4,48}[A-Z0-9])/gi,
    /\btransaction\s*(?:id|no|number|ref(?:erence)?)\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\s-]{4,48}[A-Z0-9])/gi,
  ];
  for (const pattern of labelledPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Stop the capture at a common following field flattened onto the line.
      const candidateText = match[1].split(
        /\b(?:amount|date|time|recipient|receiver|sent\s+to)\b/i,
      )[0];
      const candidate = normalizeReference(candidateText, provider);
      if (isReferenceFormatValid(candidate, provider)) return candidate;
    }
  }

  if (provider === "gcash") {
    const standalone = text.match(/(?<!\d)\d(?:[\s-]*\d){12}(?!\d)/);
    const candidate = standalone ? digitsOnly(standalone[0]) : "";
    if (/^\d{13}$/.test(candidate)) return candidate;
  }
  return null;
}

function parseMoneyToken(token: string): number | null {
  const normalized = token.replace(/[\s,]/g, "");
  if (!/^\d+(?:\.\d{2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : null;
}

function isFeeContext(context: string): boolean {
  return /\b(?:fee|charge|service\s+fee|convenience|cash[- ]?in)\b/i.test(
    context,
  );
}

export function extractReceiptAmount(text: string): AmountExtraction {
  const evidence: string[] = [];
  const reliable: number[] = [];
  const weak: number[] = [];
  const labelled =
    /(?:total\s+amount\s+sent|amount\s+sent|transfer(?:red)?\s+amount|payment\s+amount|total|amount)\s*[:=-]?\s*(?:PHP|P|₱)?\s*((?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.\d{2})?)(?![\d,.])/gi;
  let match: RegExpExecArray | null;
  while ((match = labelled.exec(text)) !== null) {
    const context = text.slice(
      Math.max(0, match.index - 28),
      match.index + match[0].length + 8,
    );
    const amount = parseMoneyToken(match[1]);
    if (amount == null || isFeeContext(context)) continue;
    reliable.push(amount);
    evidence.push(match[0].trim().slice(0, 100));
  }

  const currency =
    /(?:PHP|₱)\s*((?:\d{1,3}(?:[ ,]\d{3})+|\d+)\.\d{2})(?![\d,.])/gi;
  while ((match = currency.exec(text)) !== null) {
    const context = text.slice(
      Math.max(0, match.index - 28),
      match.index + match[0].length + 8,
    );
    const amount = parseMoneyToken(match[1]);
    if (amount == null || isFeeContext(context)) continue;
    weak.push(amount);
    evidence.push(match[0].trim().slice(0, 100));
  }

  const uniqueReliable = [...new Set(reliable)];
  if (uniqueReliable.length === 1) {
    return {
      amount: uniqueReliable[0],
      reliable: true,
      ambiguous: false,
      reason: "labelled_principal",
      evidence,
    };
  }
  if (uniqueReliable.length > 1) {
    return {
      amount: null,
      reliable: false,
      ambiguous: true,
      reason: "conflicting_labelled_amounts",
      evidence,
    };
  }

  const uniqueWeak = [...new Set(weak)];
  return {
    amount: uniqueWeak.length === 1 ? uniqueWeak[0] : null,
    reliable: false,
    ambiguous: uniqueWeak.length > 1,
    reason: uniqueWeak.length === 1
      ? "currency_only"
      : uniqueWeak.length > 1
      ? "conflicting_currency_amounts"
      : "amount_unreadable",
    evidence,
  };
}

function buildShiftedDate(
  year: number,
  month: number,
  day: number,
  hourText?: string,
  minuteText?: string,
  meridiem?: string,
): ReceiptDateTime {
  const date = `${year}-${String(month + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
  if (!hourText || minuteText == null) {
    return { date, wallTime: null, instant: null, shifted: null };
  }
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 ||
    minute > 59
  ) {
    return { date, wallTime: null, instant: null, shifted: null };
  }
  const ap = String(meridiem || "").toLowerCase().replace(/[^ap]/g, "");
  if (ap === "p" && hour < 12) hour += 12;
  if (ap === "a" && hour === 12) hour = 0;
  const shifted = new Date(Date.UTC(year, month, day, hour, minute, 0));
  return {
    date,
    wallTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    instant: new Date(shifted.getTime() - 8 * 60 * 60 * 1000),
    shifted,
  };
}

export function parseReceiptDateTime(text: string): ReceiptDateTime {
  const normalized = String(text || "").replace(/[|]/g, " ").replace(
    /\s+/g,
    " ",
  ).trim();
  const wordDate = normalized.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.-]+(\d{4})(?:[\s,|/-]+(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\.?m\.?)?)?)?/i,
  );
  if (wordDate) {
    return buildShiftedDate(
      Number(wordDate[3]),
      MONTHS[wordDate[1].toLowerCase().slice(0, 3)],
      Number(wordDate[2]),
      wordDate[4],
      wordDate[5],
      wordDate[6],
    );
  }

  const numeric = normalized.match(
    /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2})\s*[:;.]\s*(\d{2})\s*([ap](?:\.?m\.?)?)?)?\b/i,
  );
  if (!numeric) {
    return { date: null, wallTime: null, instant: null, shifted: null };
  }
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  // Philippine receipts generally use month/day. A first component above 12
  // is unambiguously day/month.
  const month = first > 12 ? second - 1 : first - 1;
  const day = first > 12 ? first : second;
  return buildShiftedDate(
    Number(numeric[3]),
    month,
    day,
    numeric[4],
    numeric[5],
    numeric[6],
  );
}

function normalizedName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, "");
}

function normalizeAccountNumber(value: string): string {
  let digits = digitsOnly(value);
  if (digits.startsWith("63") && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return digits;
}

function labelledRecipientFragments(text: string): string[] {
  const fragments: string[] = [];
  const pattern =
    /(?:^|\n)[ \t]*(?:sent[ \t]+to|recipient|receiver|beneficiary|account[ \t]+name|account[ \t]+(?:no|number)|mobile[ \t]+(?:no|number)|to)\b[ \t]*[:=-]?[ \t]*([^\r\n|]{2,80})/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) fragments.push(match[1]);

  // Current GCash receipts use an unlabelled header block:
  //   Amount
  //   AN.....A A.
  //   +63 952 482 5766
  //   Sent via GCash
  // Capture the masked name and number together. Requiring the surrounding
  // header/provider lines prevents an unrelated phone number from being used
  // as recipient evidence.
  const gcashHeader =
    /(?:^|\n)[ \t]*amount[ \t]*\r?\n[ \t]*([^\r\n|]{2,80})[ \t]*\r?\n[ \t]*((?:\+?63|0)?[\d \t-]{10,18})[ \t]*\r?\n[ \t]*sent[ \t]+via[ \t]+gcash\b/gim;
  while ((match = gcashHeader.exec(text)) !== null) {
    fragments.push(`${match[1]} ${match[2]}`);
  }
  return fragments;
}

export function checkRecipient(
  text: string,
  expectedNumber: string,
  expectedName: string,
): RecipientCheck {
  const expectedDigits = normalizeAccountNumber(expectedNumber);
  const expectedLetters = normalizedName(expectedName);
  const fragments = labelledRecipientFragments(text);
  const evidence: string[] = [];
  let numberStatus: RecipientCheck["numberStatus"] = "unreadable";
  let nameStatus: RecipientCheck["nameStatus"] = "unreadable";

  if (expectedDigits.length >= 4) {
    const fullCandidates: string[] = [];
    for (const fragment of fragments) {
      const candidates = fragment.match(
        /(?:(?:\+?63|0)[ \t-]*)?9(?:[ \t-]*\d){9}|\d{8,18}/g,
      ) || [];
      for (const candidate of candidates) {
        const normalized = normalizeAccountNumber(candidate);
        if (normalized.length >= 8) fullCandidates.push(normalized);
      }
      const lastFour = expectedDigits.slice(-4);
      if (new RegExp(`(?:[*xX•#\\s-]{2,})${lastFour}\\b`).test(fragment)) {
        numberStatus = "match";
        evidence.push(`masked recipient ending ${lastFour}`);
      }
    }
    if (fullCandidates.includes(expectedDigits)) {
      numberStatus = "match";
      evidence.push("full recipient number matched");
    } else if (fullCandidates.length > 0 && numberStatus !== "match") {
      numberStatus = "wrong";
      evidence.push("different full recipient number detected");
    }
  }

  if (expectedLetters.length >= 3) {
    const namedFragments = fragments.map(normalizedName).filter((value) =>
      value.length >= 3
    );
    if (
      namedFragments.some((value) =>
        value.includes(expectedLetters) || expectedLetters.includes(value)
      )
    ) {
      nameStatus = "match";
      evidence.push("recipient name matched");
    } else if (namedFragments.some((value) => /[A-Z]{5,}/.test(value))) {
      nameStatus = "mismatch";
      evidence.push("different labelled recipient name detected");
    }
  }

  const status = numberStatus === "wrong"
    ? "wrong"
    : numberStatus === "match" || nameStatus === "match"
    ? "match"
    : "unreadable";
  return { status, numberStatus, nameStatus, evidence };
}

export function providerEvidence(text: string, provider: PaymentProvider): {
  expected: boolean;
  conflicting: PaymentProvider | null;
} {
  const matches: Record<PaymentProvider, boolean> = {
    gcash: /\bgcash\b|g-?xchange|\bgxi\b/i.test(text),
    gotyme: /\bgo\s*tyme\b/i.test(text),
    pnb: /\bpnb\b|philippine\s+national\s+bank/i.test(text),
  };
  const conflicting =
    (Object.keys(matches) as PaymentProvider[]).find((key) =>
      key !== provider && matches[key]
    ) || null;
  return { expected: matches[provider], conflicting };
}

export function looksReceiptLike(text: string): boolean {
  const value = text.toLowerCase();
  let score = 0;
  if (/\b(?:reference|ref|transaction)\b/.test(value)) score++;
  if (/\b(?:gcash|gotyme|pnb|bank|instapay|pesonet|qrph)\b/.test(value)) {
    score++;
  }
  if (/\b(?:sent|paid|transfer|amount|successful|receipt)\b/.test(value)) {
    score++;
  }
  if (/(?:php|₱)\s*\d|\d+\.\d{2}/i.test(text)) score++;
  return score >= 2;
}

export function ocrCompletenessScore(
  text: string,
  provider: PaymentProvider,
  expectedReference: string,
): number {
  if (!text) return 0;
  let score = 0;
  if (extractReference(text, provider, expectedReference)) score += 2;
  const amount = extractReceiptAmount(text);
  if (amount.amount != null) score += amount.reliable ? 2 : 1;
  const date = parseReceiptDateTime(text);
  if (date.date) score++;
  if (date.shifted) score++;
  if (providerEvidence(text, provider).expected) score++;
  return score;
}
