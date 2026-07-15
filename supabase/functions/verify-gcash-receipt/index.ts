// Token-bound, persisted-target receipt verification for CourtYard Pickleball.
// OCR is a screening signal, never payment-provider attestation. A clean read
// remains pending for an owner to confirm funds. OCR contradictions also remain
// pending; only a payment-reference replay confirmed by the database rejects.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRecipient,
  extractReceiptAmount,
  extractReference,
  isReferenceFormatValid,
  looksReceiptLike,
  normalizeProvider,
  normalizeReference,
  ocrCompletenessScore,
  parseReceiptDateTime,
  PaymentProvider,
  providerEvidence,
} from "../_shared/receipt-parser.ts";
import {
  deriveCourtPayment,
  deriveOpenPlayPayment,
  ExpectedPayment,
  SettingsMap,
} from "../_shared/receipt-payment.ts";
import {
  isReceiptToken,
  providerLedgerKey,
  ReceiptDecision,
  receiptTokenMatches,
  routeReceiptDecision,
  sha256BytesHex,
} from "../_shared/receipt-security.ts";

type TargetType = "booking" | "open_play";

type VerificationTarget = {
  type: TargetType;
  key: string;
  ownerKey: string;
  table: "bookings" | "open_play_registrations";
  idColumn: "ref" | "id";
  row: Record<string, unknown>;
};

type OcrEngineResult = {
  text: string;
  confidence: number;
};

type OcrRunResult = OcrEngineResult & {
  provider: "google_vision" | "ocr_space" | "google_vision+ocr_space" | "none";
  primaryError: string | null;
  fallbackError: string | null;
  fallbackAttempted: boolean;
};

type IncomingReceipt = {
  blob: Blob;
  contentType: string;
};

type ParsedRequest =
  | { ok: true; body: Record<string, unknown>; receipt: IncomingReceipt | null }
  | { ok: false; response: Response };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PAYMENT_WINDOW_MINUTES = 15;
const EARLY_TOLERANCE_MINUTES = 2;
const OPEN_PLAY_EARLY_TOLERANCE_MINUTES = 15;
const PESO_TOLERANCE = 5;
const ATTEMPT_WINDOW_MINUTES = 15;
const DEFAULT_MAX_ATTEMPTS = 5;
const RECEIPT_BUCKET = "receipts";
const DASHBOARD_ROLES = new Set(["owner", "court_owner", "staff"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    if (typeof value.details === "string") return value.details;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object"
    ? String((error as Record<string, unknown>).code || "")
    : "";
}

function addFlag(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64ToBytes(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const raw = value.startsWith("data:") && comma >= 0
    ? value.slice(comma + 1)
    : value;
  const binary = atob(raw.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function normalizedContentType(value: unknown): string | null {
  const raw = String(value || "").toLowerCase().split(";", 1)[0].trim();
  const normalized = raw === "image/jpg" ? "image/jpeg" : raw;
  return ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
      .includes(normalized)
    ? normalized
    : null;
}

function dataUrlContentType(value: string): string | null {
  const match = /^data:([^;,]+);base64,/i.exec(value.trimStart());
  return match ? normalizedContentType(match[1]) : null;
}

function mimeTypesCompatible(left: string, right: string): boolean {
  if (left === right) return true;
  const heifFamily = new Set(["image/heic", "image/heif"]);
  return heifFamily.has(left) && heifFamily.has(right);
}

function detectedImageContentType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp"
  ) {
    const brands = String.fromCharCode(
      ...bytes.subarray(8, Math.min(bytes.length, 48)),
    );
    if (/(heic|heix|hevc|hevx)/.test(brands)) return "image/heic";
    if (/(mif1|msf1)/.test(brands)) return "image/heif";
  }
  return null;
}

async function parseIncomingRequest(req: Request): Promise<ParsedRequest> {
  let raw: ArrayBuffer;
  try {
    raw = await req.arrayBuffer();
  } catch {
    return {
      ok: false,
      response: json({ error: "Request body could not be read" }, 400),
    };
  }
  if (raw.byteLength > MAX_REQUEST_BYTES) {
    return { ok: false, response: json({ error: "Request too large" }, 413) };
  }

  const header = req.headers.get("content-type") || "";
  const mediaType = header.toLowerCase().split(";", 1)[0].trim();
  if (mediaType === "multipart/form-data") {
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "Content-Type": header } })
        .formData();
    } catch {
      return {
        ok: false,
        response: json({ error: "Invalid multipart body" }, 400),
      };
    }

    const body: Record<string, unknown> = {};
    let receiptBlob: Blob | null = null;
    for (const [name, value] of form.entries()) {
      if (name === "receipt") {
        if (!(value instanceof Blob) || receiptBlob) {
          return {
            ok: false,
            response: json(
              { error: "Exactly one receipt image is required" },
              400,
            ),
          };
        }
        receiptBlob = value;
      } else if (typeof value === "string") {
        body[name] = value;
      } else {
        return {
          ok: false,
          response: json({ error: "Unexpected binary form field" }, 400),
        };
      }
    }

    if (!receiptBlob) return { ok: true, body, receipt: null };
    if (receiptBlob.size === 0) {
      return {
        ok: false,
        response: json({ error: "Receipt image is empty" }, 400),
      };
    }
    if (receiptBlob.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        response: json({ error: "Receipt image exceeds 5 MB" }, 413),
      };
    }
    const fileType = receiptBlob.type
      ? normalizedContentType(receiptBlob.type)
      : null;
    const fieldType = body.contentType == null
      ? null
      : normalizedContentType(body.contentType);
    if (
      (receiptBlob.type && !fileType) ||
      (body.contentType != null && !fieldType)
    ) {
      return {
        ok: false,
        response: json({ error: "Unsupported receipt image type" }, 415),
      };
    }
    if (fileType && fieldType && !mimeTypesCompatible(fileType, fieldType)) {
      return {
        ok: false,
        response: json({ error: "Receipt image type does not match" }, 415),
      };
    }
    const contentType = fileType || fieldType;
    if (!contentType) {
      return {
        ok: false,
        response: json({ error: "Receipt image type is required" }, 415),
      };
    }
    return { ok: true, body, receipt: { blob: receiptBlob, contentType } };
  }

  if (
    mediaType && mediaType !== "application/json" &&
    !mediaType.endsWith("+json")
  ) {
    return {
      ok: false,
      response: json({ error: "Unsupported request content type" }, 415),
    };
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        response: json({ error: "JSON body must be an object" }, 400),
      };
    }
    return { ok: true, body: value as Record<string, unknown>, receipt: null };
  } catch {
    return { ok: false, response: json({ error: "Invalid JSON body" }, 400) };
  }
}

function imageExtension(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/heic" || contentType === "image/heif") {
    return "heic";
  }
  return "jpg";
}

function safeObjectSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

function toPhWallClock(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
}

function editedBySoftware(bytes: Uint8Array): boolean {
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let text = "";
  for (let index = 0; index < slice.length; index++) {
    text += String.fromCharCode(slice[index]);
  }
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i
    .test(text);
}

function expectedMerchant(
  settings: SettingsMap,
  provider: PaymentProvider,
): { number: string; name: string } {
  return {
    number: settings[`${provider}_merchant_number`] || "",
    name: settings[`${provider}_merchant_name`] || "",
  };
}

function maskNumber(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : null;
}

function publicMessage(
  result: ReceiptDecision,
  flags: string[],
  paymentConfirmed = false,
): string {
  if (result === "auto_approved") {
    if (paymentConfirmed) {
      return "GCash receipt verified automatically. Your payment and booking are confirmed.";
    }
    return "Automated receipt screening passed. Payment remains pending until the owner confirms the funds.";
  }
  if (result === "manual_review") {
    if (
      flags.includes("OCR_UNAVAILABLE") ||
      flags.includes("OCR_PRIMARY_UNAVAILABLE")
    ) {
      return "Receipt stored. Automatic reading is temporarily unavailable, so the owner will review it and confirm the funds separately.";
    }
    return "Receipt stored. The owner will review it and confirm the funds separately.";
  }
  return "This payment reference is already attached to another registration. Please contact the owner.";
}

function terminalResult(row: Record<string, unknown>): ReceiptDecision | null {
  // receipt_status=auto_approved is only a document-screening label. Actual
  // confirmation comes from the booking/payment lifecycle fields below.
  const paymentStatus = String(row.payment_status || "");
  const status = String(row.status || "");
  if (paymentStatus === "rejected" || status === "cancelled") {
    return "rejected";
  }
  if (
    paymentStatus === "paid" || paymentStatus === "downpayment_paid" ||
    status === "confirmed" || status === "completed"
  ) return "auto_approved";
  return null;
}

function terminalResponse(target: VerificationTarget): Response | null {
  const result = terminalResult(target.row);
  if (!result) return null;
  const flags = Array.isArray(target.row.receipt_flags)
    ? target.row.receipt_flags.map(String)
    : [];
  return json({
    ok: true,
    status: result,
    flags,
    publicReason: result === "rejected"
      ? "This payment was already rejected."
      : "This payment was already confirmed in the booking system.",
    extracted: target.row.receipt_extracted || null,
    confidence: target.row.receipt_confidence ?? null,
    receiptImageUrl: target.row.receipt_image_url || null,
    receiptImageHash: target.row.receipt_image_hash || null,
    receiptPhash: target.row.receipt_phash || null,
    receiptVerifiedAt: target.row.receipt_verified_at || null,
    paymentConfirmed: result === "auto_approved",
    requiresOwnerConfirmation: false,
    message: "This receipt has already been processed.",
  });
}

function submittedResponse(target: VerificationTarget): Response | null {
  if (!target.row.receipt_upload_token_used_at) return null;
  const imagePath = String(target.row.receipt_image_url || "");
  const imageHash = String(target.row.receipt_image_hash || "");
  if (!imagePath || !imageHash) {
    return json({
      error:
        "This receipt token was consumed without durable evidence. Contact the owner.",
    }, 409);
  }
  const flags = Array.isArray(target.row.receipt_flags)
    ? target.row.receipt_flags.map(String).filter((flag) =>
      flag !== "VERIFICATION_IN_PROGRESS"
    )
    : [];
  const storedReceiptStatus = String(target.row.receipt_status || "");
  // Preserve a completed clean screening across retries without representing
  // it as confirmation that money reached the merchant account.
  const screeningStatus: ReceiptDecision = storedReceiptStatus ===
      "auto_approved"
    ? "auto_approved"
    : storedReceiptStatus === "rejected" && flags.includes("DUPLICATE_REF")
    ? "rejected"
    : "manual_review";
  const reason = publicMessage(screeningStatus, flags);
  return json({
    ok: true,
    status: screeningStatus,
    flags,
    publicReason: reason,
    extracted: target.row.receipt_extracted || null,
    confidence: target.row.receipt_confidence ?? null,
    receiptImageUrl: imagePath,
    receiptImageHash: imageHash,
    receiptPhash: target.row.receipt_phash || null,
    receiptVerifiedAt: target.row.receipt_verified_at || null,
    paymentConfirmed: false,
    requiresOwnerConfirmation: screeningStatus !== "rejected",
    message: reason,
  });
}

function parseTargetType(body: Record<string, unknown>): TargetType | null {
  const explicit = String(body.targetType || body.target_type || "")
    .toLowerCase();
  if (explicit === "booking") return "booking";
  if (explicit === "open_play" || explicit === "openplay") return "open_play";
  if (body.openPlayRegistrationId || body.open_play_registration_id) {
    return "open_play";
  }
  if (body.bookingRef) return "booking";
  return null;
}

function targetKeyFromBody(
  body: Record<string, unknown>,
  type: TargetType,
): string {
  if (type === "booking") {
    return String(body.bookingRef || body.targetKey || body.target_key || "")
      .trim();
  }
  return String(
    body.openPlayRegistrationId || body.open_play_registration_id ||
      body.targetKey || body.target_key || "",
  ).trim();
}

async function loadTarget(
  db: any,
  type: TargetType,
  key: string,
): Promise<VerificationTarget | null> {
  if (type === "booking") {
    const { data, error } = await db.from("bookings").select(
      "ref,court_id,slots,total,downpayment,gcash_ref,payment_method,payment_flow,date,payment_status,status,full_name,contact_number,email,created_at,receipt_upload_token_hash,receipt_upload_token_expires_at,receipt_upload_token_used_at,receipt_image_url,receipt_image_hash,receipt_phash,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_verified_at",
    ).eq("ref", key).maybeSingle();
    if (error) throw new Error(`Booking could not be loaded: ${errMsg(error)}`);
    return data
      ? {
        type,
        key,
        ownerKey: `BK:${key}`,
        table: "bookings",
        idColumn: "ref",
        row: data,
      }
      : null;
  }
  const { data, error } = await db.from("open_play_registrations").select(
    "id,court_id,date,hour,session_key,session_start,session_end,base_fee,system_fee,total_due,payment_type,amount,payment_method,gcash_ref,payment_status,full_name,created_at,receipt_upload_token_hash,receipt_upload_token_expires_at,receipt_upload_token_used_at,receipt_image_url,receipt_image_hash,receipt_phash,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_verified_at",
  ).eq("id", key).maybeSingle();
  if (error) {
    throw new Error(
      `Open Play registration could not be loaded: ${errMsg(error)}`,
    );
  }
  return data
    ? {
      type,
      key: String(data.id),
      ownerKey: `OP:${data.id}`,
      table: "open_play_registrations",
      idColumn: "id",
      row: data,
    }
    : null;
}

function missingAttemptTable(error: unknown): boolean {
  const code = errorCode(error);
  const message = errMsg(error).toLowerCase();
  return code === "42P01" || code === "PGRST205" ||
    (message.includes("receipt_verification_attempts") &&
      (message.includes("does not exist") || message.includes("schema cache")));
}

async function recordRateLimitAttempt(
  db: any,
  target: VerificationTarget,
): Promise<{ limited: boolean; available: boolean; count: number }> {
  const configured = Number(
    Deno.env.get("RECEIPT_VERIFY_MAX_ATTEMPTS") || DEFAULT_MAX_ATTEMPTS,
  );
  const maximum = Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 20)
    : DEFAULT_MAX_ATTEMPTS;
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MINUTES * 60_000)
    .toISOString();
  const { count, error } = await db.from("receipt_verification_attempts")
    .select("*", { count: "exact", head: true })
    .eq("target_type", target.type)
    .eq("target_key", target.key)
    .gte("attempted_at", since);
  if (error) {
    if (missingAttemptTable(error)) {
      console.warn(
        "receipt_verification_attempts is not installed; rate limiting is unavailable",
      );
      return { limited: false, available: false, count: 0 };
    }
    throw new Error(`Receipt rate-limit check failed: ${errMsg(error)}`);
  }
  const current = Number(count || 0);
  if (current >= maximum) {
    return { limited: true, available: true, count: current };
  }
  const { error: insertError } = await db.from("receipt_verification_attempts")
    .insert({
      target_type: target.type,
      target_key: target.key,
      attempted_at: new Date().toISOString(),
    });
  if (insertError) {
    throw new Error(
      `Receipt attempt could not be recorded: ${errMsg(insertError)}`,
    );
  }
  return { limited: false, available: true, count: current + 1 };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("OCR provider request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function visionConfidence(
  annotation: Record<string, unknown> | null,
  text: string,
): number {
  if (!annotation) return text.length > 40 ? 0.8 : text.length > 0 ? 0.45 : 0;
  let sum = 0;
  let count = 0;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.confidence === "number" && item.confidence > 0) {
      sum += item.confidence;
      count++;
    }
    for (const key of ["pages", "blocks", "paragraphs", "words", "symbols"]) {
      const children = item[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
  };
  visit(annotation);
  return count > 0
    ? sum / count
    : text.length > 40
    ? 0.8
    : text.length > 0
    ? 0.45
    : 0;
}

async function googleVisionOcr(
  apiKey: string,
  base64: string,
): Promise<OcrEngineResult> {
  const response = await fetchWithTimeout(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
    },
    25_000,
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Vision ${response.status}: ${errMsg(data)}`);
  }
  const result = data?.responses?.[0];
  if (result?.error) throw new Error(`Google Vision: ${errMsg(result.error)}`);
  const text = String(
    result?.fullTextAnnotation?.text ||
      result?.textAnnotations?.[0]?.description || "",
  ).trim();
  return {
    text,
    confidence: visionConfidence(result?.fullTextAnnotation || null, text),
  };
}

async function ocrSpaceOcr(
  apiKey: string,
  base64: string,
  contentType: string,
): Promise<OcrEngineResult> {
  const form = new FormData();
  form.append("base64Image", `data:${contentType};base64,${base64}`);
  form.append("language", "eng");
  form.append("OCREngine", "2");
  form.append("scale", "true");
  form.append("isTable", "true");
  const response = await fetchWithTimeout(
    "https://api.ocr.space/parse/image",
    { method: "POST", headers: { apikey: apiKey }, body: form },
    25_000,
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OCR.space ${response.status}: ${errMsg(data)}`);
  }
  if (data?.IsErroredOnProcessing) {
    throw new Error(`OCR.space: ${errMsg(data?.ErrorMessage || data)}`);
  }
  const text = (Array.isArray(data?.ParsedResults) ? data.ParsedResults : [])
    .map((item: { ParsedText?: string }) => item?.ParsedText || "")
    .join("\n")
    .trim();
  return {
    text,
    confidence: text.length > 40 ? 0.75 : text.length > 0 ? 0.4 : 0,
  };
}

async function runOcr(input: {
  visionKey: string;
  ocrSpaceKey: string;
  base64: string;
  contentType: string;
  provider: PaymentProvider;
  expectedReference: string;
}): Promise<OcrRunResult> {
  let primary: OcrEngineResult | null = null;
  let fallback: OcrEngineResult | null = null;
  let primaryError: string | null = null;
  let fallbackError: string | null = null;
  let fallbackAttempted = false;

  if (input.visionKey) {
    try {
      primary = await googleVisionOcr(input.visionKey, input.base64);
    } catch (error) {
      primaryError = errMsg(error);
      console.error("Google Vision OCR failed:", primaryError);
    }
  } else {
    primaryError = "Google Vision is not configured";
  }

  const primaryScore = ocrCompletenessScore(
    primary?.text || "",
    input.provider,
    input.expectedReference,
  );
  if (input.ocrSpaceKey && (!primary?.text || primaryScore < 6)) {
    fallbackAttempted = true;
    try {
      fallback = await ocrSpaceOcr(
        input.ocrSpaceKey,
        input.base64,
        input.contentType,
      );
    } catch (error) {
      fallbackError = errMsg(error);
      console.error("OCR.space fallback failed:", fallbackError);
    }
  }

  const fallbackScore = ocrCompletenessScore(
    fallback?.text || "",
    input.provider,
    input.expectedReference,
  );
  const useFallback = !!fallback && (
    !primary || fallbackScore > primaryScore ||
    (fallbackScore === primaryScore && fallback.confidence > primary.confidence)
  );
  const chosen = useFallback ? fallback : primary;
  const provider = primary && fallback
    ? "google_vision+ocr_space"
    : useFallback
    ? "ocr_space"
    : primary
    ? "google_vision"
    : fallback
    ? "ocr_space"
    : "none";
  return {
    text: chosen?.text || "",
    confidence: chosen?.confidence || 0,
    provider,
    primaryError,
    fallbackError,
    fallbackAttempted,
  };
}

async function loadSettings(db: any): Promise<SettingsMap> {
  const { data, error } = await db.from("settings").select("key,value");
  if (error) throw new Error(`Settings could not be loaded: ${errMsg(error)}`);
  const settings: SettingsMap = {};
  for (const row of data || []) {
    settings[String(row.key)] = String(row.value ?? "");
  }
  return settings;
}

async function deriveExpectedPayment(
  db: any,
  target: VerificationTarget,
  settings: SettingsMap,
): Promise<ExpectedPayment> {
  if (target.type === "open_play") {
    return deriveOpenPlayPayment({ registration: target.row, settings });
  }
  const courtId = String(target.row.court_id || "");
  if (!courtId) throw new Error("Booking court is missing");
  const { data: court, error } = await db.from("courts").select(
    "rate,rate_schedule",
  )
    .eq("id", courtId).maybeSingle();
  if (error || !court) {
    throw new Error(
      `Court pricing could not be loaded: ${errMsg(error || "not found")}`,
    );
  }
  return deriveCourtPayment({
    slots: target.row.slots,
    courtRate: court.rate,
    courtRateSchedule: court.rate_schedule,
    fallbackRateSchedule: settings.pricing_tiers,
    serviceFeeRate: settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
    feeType: settings.fee_type,
    storedDue: target.row.downpayment,
    storedTotal: target.row.total,
    acceptanceMode: settings.payment_acceptance_mode,
  });
}

async function checkpointEvidence(
  db: any,
  target: VerificationTarget,
  update: Record<string, unknown>,
): Promise<boolean> {
  const checkpointTime = String(update.receipt_upload_token_used_at || "");
  let query = db.from(target.table).update(
    target.type === "booking"
      ? { ...update, status: "pending", payment_status: "for_verification" }
      : { ...update, payment_status: "pending" },
  ).eq(target.idColumn, target.key)
    .is("receipt_upload_token_used_at", null)
    .gt("receipt_upload_token_expires_at", checkpointTime);
  query = target.type === "booking"
    ? query.in("status", ["verifying", "pending"])
    : query.eq("payment_status", "pending").in("receipt_status", [
      "none",
      "manual_review",
    ]);
  const { data, error } = await query.select(target.idColumn);
  if (error) {
    throw new Error(`Receipt evidence could not be attached: ${errMsg(error)}`);
  }
  return Array.isArray(data) && data.length > 0;
}

async function finalizeTarget(
  db: any,
  target: VerificationTarget,
  imageHash: string,
  update: Record<string, unknown>,
): Promise<{ updated: boolean; error: string | null }> {
  let query = db.from(target.table).update(update)
    .eq(target.idColumn, target.key)
    .eq("receipt_image_hash", imageHash);
  query = target.type === "booking"
    ? query.in("status", ["verifying", "pending"])
    : query.eq("payment_status", "pending");
  const { data, error } = await query.select(target.idColumn);
  return {
    updated: !error && Array.isArray(data) && data.length > 0,
    error: error ? errMsg(error) : null,
  };
}

async function ledgerState(
  db: any,
  target: VerificationTarget,
  provider: PaymentProvider,
  normalizedReference: string,
): Promise<{
  claimedByTarget: boolean;
  claimedByOther: boolean;
  unavailable: boolean;
}> {
  const key = providerLedgerKey(provider, normalizedReference);
  const keys = provider === "gcash" ? [key, normalizedReference] : [key];
  const { data, error } = await db.from("used_gcash_refs")
    .select("gcash_ref,booking_ref")
    .in("gcash_ref", keys);
  if (error) {
    console.error("payment ledger lookup failed:", errMsg(error));
    return {
      claimedByTarget: false,
      claimedByOther: false,
      unavailable: true,
    };
  }
  const aliases = new Set([
    target.ownerKey,
    target.type === "booking" ? target.key : "",
  ]);
  let claimedByTarget = false;
  let claimedByOther = false;
  for (const row of data || []) {
    if (aliases.has(String(row.booking_ref || ""))) claimedByTarget = true;
    else claimedByOther = true;
  }
  return { claimedByTarget, claimedByOther, unavailable: false };
}

async function insertAudit(
  db: any,
  target: VerificationTarget,
  result: ReceiptDecision,
  flags: string[],
  extracted: Record<string, unknown>,
  confidence: number,
  imageHash: string,
  rawText: string,
): Promise<string | null> {
  const { error } = await db.from("receipt_verifications").insert({
    booking_ref: target.ownerKey,
    result,
    flags,
    extracted,
    confidence,
    image_hash: imageHash,
    phash: null,
    raw_ocr_text: rawText || null,
  });
  return error ? errMsg(error) : null;
}

async function sendTelegram(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const rawIds = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!token || !rawIds) return;
  const ids = rawIds.split(",").map((value) => value.trim()).filter(Boolean);
  await Promise.allSettled(
    ids.map((chatId) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      })
    ),
  );
}

async function authorizeReceiptViewer(
  req: Request,
  db: any,
  supabaseUrl: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!token || !anonKey) {
    return { ok: false, response: json({ error: "Unauthorized" }, 401) };
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return { ok: false, response: json({ error: "Unauthorized" }, 401) };
  }
  const { data: account, error: accountError } = await db.from("accounts")
    .select("role").eq("id", userData.user.id).maybeSingle();
  if (accountError) {
    console.error("receipt viewer role lookup failed:", errMsg(accountError));
    return {
      ok: false,
      response: json({ error: "Authorization check failed" }, 500),
    };
  }
  if (!account || !DASHBOARD_ROLES.has(String(account.role || ""))) {
    return { ok: false, response: json({ error: "Forbidden" }, 403) };
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(requestLength) && requestLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request too large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Receipt service is not configured" }, 500);
  }
  const db = createClient(supabaseUrl, serviceRoleKey);

  const parsedRequest = await parseIncomingRequest(req);
  if (!parsedRequest.ok) return parsedRequest.response;
  const { body, receipt: multipartReceipt } = parsedRequest;
  const action = String(body.action || "verify").toLowerCase();

  if (action === "sign") {
    const authorization = await authorizeReceiptViewer(req, db, supabaseUrl);
    if (!authorization.ok) return authorization.response;
    const targetType = parseTargetType(body);
    if (!targetType) return json({ error: "targetType is required" }, 400);
    const targetKey = targetKeyFromBody(body, targetType);
    if (!targetKey) {
      return json({ error: "Target identifier is required" }, 400);
    }
    try {
      const target = await loadTarget(db, targetType, targetKey);
      const path = String(target?.row.receipt_image_url || "");
      if (!target || !path) return json({ error: "No receipt on file" }, 404);
      const { data, error } = await db.storage.from(RECEIPT_BUCKET)
        .createSignedUrl(path, 300);
      if (error || !data?.signedUrl) {
        return json({ error: "Receipt could not be signed" }, 500);
      }
      return json({ ok: true, url: data.signedUrl });
    } catch (error) {
      console.error("receipt sign failed:", errMsg(error));
      return json({ error: "Receipt could not be loaded" }, 500);
    }
  }

  if (action !== "verify") return json({ error: "Unsupported action" }, 400);

  try {
    const targetType = parseTargetType(body);
    if (!targetType) {
      return json({ error: "targetType must be booking or open_play" }, 400);
    }
    const targetKey = targetKeyFromBody(body, targetType);
    if (!targetKey || targetKey.length > 160) {
      return json({ error: "Valid target identifier required" }, 400);
    }
    if (body.bookingData != null) {
      return json({
        error:
          "Inline bookingData is not accepted; save the payment target first",
      }, 400);
    }

    const receiptToken = body.receiptToken;
    if (!isReceiptToken(receiptToken)) {
      return json({ error: "A valid receiptToken is required" }, 400);
    }

    const target = await loadTarget(db, targetType, targetKey);
    if (!target) return json({ error: "Payment target not found" }, 404);
    const storedTokenHash = String(target.row.receipt_upload_token_hash || "");
    if (!storedTokenHash) {
      return json({
        error: "Receipt upload is not initialized for this payment",
      }, 409);
    }
    if (!(await receiptTokenMatches(receiptToken, storedTokenHash))) {
      return json({ error: "Receipt authorization failed" }, 403);
    }
    const tokenExpiresAt = Date.parse(
      String(target.row.receipt_upload_token_expires_at || ""),
    );
    if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
      return json({ error: "Receipt authorization has expired" }, 410);
    }

    // Token validation always happens before terminal disclosure, storage, or OCR.
    const terminal = terminalResponse(target);
    if (terminal) return terminal;
    const previouslySubmitted = submittedResponse(target);
    if (previouslySubmitted) return previouslySubmitted;

    // A booking token is created with the short-lived, non-PII slot hold. The
    // same token becomes a receipt capability only after the finalize RPC has
    // replaced that exact placeholder. Consuming it earlier would strand an
    // anonymous hold in a durable pending state.
    if (
      target.type === "booking" &&
      String(target.row.full_name || "") === "Reserving…" &&
      String(target.row.contact_number || "") === "00000000000" &&
      String(target.row.email || "") === "reserve@hold.internal" &&
      target.row.payment_flow == null
    ) {
      return json({
        error: "Finalize the booking before uploading its receipt",
      }, 409);
    }

    const attempt = await recordRateLimitAttempt(db, target);
    if (attempt.limited) {
      return json({
        error:
          "Too many receipt verification attempts. Please wait or contact the owner.",
        retryAfterSeconds: ATTEMPT_WINDOW_MINUTES * 60,
      }, 429);
    }

    let bytes: Uint8Array;
    let contentType: string;
    if (multipartReceipt) {
      bytes = new Uint8Array(await multipartReceipt.blob.arrayBuffer());
      contentType = multipartReceipt.contentType;
    } else {
      const imageBase64Input = typeof body.imageBase64 === "string"
        ? body.imageBase64
        : "";
      if (!imageBase64Input) {
        return json({ error: "Receipt image is required" }, 400);
      }
      // A 5 MB binary payload cannot exceed this many base64 characters (plus
      // a small data-URL prefix). Bound it before atob allocates memory.
      if (imageBase64Input.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256) {
        return json({ error: "Receipt image exceeds 5 MB" }, 413);
      }
      const fieldType = body.contentType == null
        ? null
        : normalizedContentType(body.contentType);
      const dataType = dataUrlContentType(imageBase64Input);
      if (body.contentType != null && !fieldType) {
        return json({ error: "Unsupported receipt image type" }, 415);
      }
      if (fieldType && dataType && !mimeTypesCompatible(fieldType, dataType)) {
        return json({ error: "Receipt image type does not match" }, 415);
      }
      const declaredType = fieldType || dataType;
      if (!declaredType) {
        return json({ error: "Receipt image type is required" }, 415);
      }
      contentType = declaredType;
      try {
        bytes = base64ToBytes(imageBase64Input);
      } catch {
        return json({ error: "Receipt image is not valid base64" }, 400);
      }
    }
    if (bytes.length === 0) {
      return json({ error: "Receipt image is empty" }, 400);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return json({ error: "Receipt image exceeds 5 MB" }, 413);
    }
    const detectedType = detectedImageContentType(bytes);
    if (!detectedType || !mimeTypesCompatible(contentType, detectedType)) {
      return json({
        error: "Receipt contents do not match a supported image type",
      }, 415);
    }

    const imageHash = await sha256BytesHex(bytes);
    if (tokenExpiresAt <= Date.now()) {
      return json({ error: "Receipt authorization has expired" }, 410);
    }
    const objectPath = `${target.type}/${
      safeObjectSegment(target.key)
    }/${imageHash}.${imageExtension(contentType)}`;
    const { error: uploadError } = await db.storage.from(RECEIPT_BUCKET).upload(
      objectPath,
      bytes,
      { contentType, upsert: true },
    );
    if (uploadError) {
      console.error("receipt evidence upload failed:", errMsg(uploadError));
      return json(
        { error: "Receipt image could not be stored. Please retry." },
        500,
      );
    }

    const checkpointAt = new Date().toISOString();
    const checkpoint = {
      // The one-time token is consumed in the same database write that attaches
      // the already-durable object. It is never consumed before Storage succeeds.
      receipt_upload_token_used_at: checkpointAt,
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: null,
      receipt_status: "manual_review",
      receipt_flags: ["VERIFICATION_IN_PROGRESS"],
      receipt_extracted: {
        targetType: target.type,
        evidenceStoredAt: checkpointAt,
      },
      receipt_confidence: 0,
      receipt_verified_at: checkpointAt,
    };
    if (!(await checkpointEvidence(db, target, checkpoint))) {
      const current = await loadTarget(db, target.type, target.key);
      const currentTerminal = current ? terminalResponse(current) : null;
      if (currentTerminal) return currentTerminal;
      const currentSubmission = current ? submittedResponse(current) : null;
      if (currentSubmission) return currentSubmission;
      return json({
        error:
          "Receipt was stored but could not be attached to an active payment. Contact the owner.",
      }, 409);
    }

    const flags: string[] = [];
    let settings: SettingsMap = {};
    let expected: ExpectedPayment | null = null;
    let pricingError: string | null = null;
    try {
      settings = await loadSettings(db);
      expected = await deriveExpectedPayment(db, target, settings);
      if (expected.snapshotMismatch) {
        addFlag(flags, "PRICING_SNAPSHOT_MISMATCH");
      }
    } catch (error) {
      pricingError = errMsg(error);
      addFlag(flags, "PRICING_ERROR");
    }

    const persistedProvider = normalizeProvider(target.row.payment_method);
    if (!persistedProvider) {
      addFlag(flags, "PAYMENT_METHOD_UNSUPPORTED");
    }
    const requestProvider = body.provider == null
      ? null
      : normalizeProvider(body.provider);
    if (
      requestProvider && persistedProvider &&
      requestProvider !== persistedProvider
    ) {
      addFlag(flags, "PROVIDER_REQUEST_MISMATCH");
    }
    // The request provider is only a consistency signal. Persisted payment
    // state remains authoritative; an absent/unsupported method cannot auto-pass.
    const provider = persistedProvider || "gcash";
    const typedReference = normalizeReference(target.row.gcash_ref, provider);
    if (!isReferenceFormatValid(typedReference, provider)) {
      addFlag(flags, "REF_FORMAT_INVALID");
    }

    const base64 = bytesToBase64(bytes);
    const ocr = await runOcr({
      visionKey: Deno.env.get("GOOGLE_VISION_API_KEY") || "",
      ocrSpaceKey: Deno.env.get("OCRSPACE_API_KEY") || "",
      base64,
      contentType,
      provider,
      expectedReference: typedReference,
    });
    if (ocr.primaryError) addFlag(flags, "OCR_PRIMARY_UNAVAILABLE");
    if (ocr.fallbackAttempted && ocr.fallbackError) {
      addFlag(flags, "OCR_FALLBACK_UNAVAILABLE");
    }
    if (!ocr.text) {
      addFlag(
        flags,
        ocr.primaryError || ocr.fallbackError
          ? "OCR_UNAVAILABLE"
          : "IMAGE_UNREADABLE",
      );
    }

    const extractedReference = extractReference(
      ocr.text,
      provider,
      typedReference,
    );
    const amount = extractReceiptAmount(ocr.text);
    const receiptDateTime = parseReceiptDateTime(ocr.text);
    const startedAt = toPhWallClock(target.row.created_at);
    const startedDate = startedAt?.toISOString().slice(0, 10) || null;
    const receiptAgeMinutes = startedAt && receiptDateTime.shifted
      ? (receiptDateTime.shifted.getTime() - startedAt.getTime()) / 60_000
      : null;
    // Open Play is persisted only when the customer submits the form, after
    // they have made the transfer and selected its screenshot. Allow that
    // expected pre-insert interval without weakening booking-hold timing.
    const earlyToleranceMinutes = target.type === "open_play"
      ? OPEN_PLAY_EARLY_TOLERANCE_MINUTES
      : EARLY_TOLERANCE_MINUTES;
    const merchant = expectedMerchant(settings, provider);
    const recipient = checkRecipient(ocr.text, merchant.number, merchant.name);
    const providerCheck = providerEvidence(ocr.text, provider);

    if (ocr.text) {
      if (!extractedReference) addFlag(flags, "REF_UNREADABLE");
      else if (typedReference && extractedReference !== typedReference) {
        addFlag(flags, "REF_MISMATCH");
      }

      if (amount.amount == null) addFlag(flags, "AMOUNT_UNREADABLE");
      else if (!amount.reliable) addFlag(flags, "AMOUNT_REVIEW");
      else if (expected && amount.amount < expected.due - PESO_TOLERANCE) {
        addFlag(flags, "AMOUNT_MISMATCH");
      } else if (expected && amount.amount > expected.due + PESO_TOLERANCE) {
        addFlag(flags, "AMOUNT_OVERPAYMENT_REVIEW");
      }

      if (!receiptDateTime.date) addFlag(flags, "DATE_UNREADABLE");
      else if (startedDate && receiptDateTime.date !== startedDate) {
        addFlag(flags, "DATE_MISMATCH");
      }
      if (!receiptDateTime.shifted || !startedAt) {
        addFlag(flags, "TIME_UNREADABLE");
      } else if ((receiptAgeMinutes as number) < -earlyToleranceMinutes) {
        addFlag(flags, "TIME_BEFORE_TARGET");
      } else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
        addFlag(flags, "TIME_OUTSIDE_WINDOW");
      }

      if (providerCheck.conflicting) addFlag(flags, "METHOD_MISMATCH");
      else if (!providerCheck.expected) addFlag(flags, "PROVIDER_UNREADABLE");

      if (!merchant.number && !merchant.name) {
        addFlag(flags, "RECIPIENT_CONFIG_MISSING");
      } else if (recipient.status === "wrong") {
        addFlag(flags, "WRONG_RECIPIENT");
      } else if (recipient.status === "unreadable") {
        addFlag(flags, "RECIPIENT_UNREADABLE");
      }
      if (recipient.nameStatus === "mismatch") {
        addFlag(flags, "RECEIVER_NAME_MISMATCH");
      }

      if (!looksReceiptLike(ocr.text)) addFlag(flags, "SUSPECTED_FAKE");
      if (ocr.confidence < 0.55) addFlag(flags, "LOW_OCR_CONFIDENCE");
    }
    if (editedBySoftware(bytes)) addFlag(flags, "EDITED_METADATA");

    // Screening is read-only against the trusted reference ledger. Even a clean,
    // matching OCR read must never reserve a reference: only owner approval may
    // create a claim. A claim belonging to this target is harmless; another
    // target's trusted claim is a deterministic replay.
    const positiveReferenceMatch = !!(
      extractedReference && typedReference &&
      extractedReference === typedReference &&
      isReferenceFormatValid(typedReference, provider)
    );
    let ledger: Awaited<ReturnType<typeof ledgerState>> | null = null;
    if (positiveReferenceMatch) {
      ledger = await ledgerState(db, target, provider, typedReference);
      if (ledger.unavailable) addFlag(flags, "LEDGER_UNAVAILABLE");
      else if (ledger.claimedByOther) addFlag(flags, "DUPLICATE_REF");
    }

    // OCR-derived flags can only request owner review. DUPLICATE_REF is added
    // exclusively from the read-only trusted-ledger lookup and is the sole reject.
    let result = routeReceiptDecision(flags);

    let confidence = result === "auto_approved"
      ? Math.max(0.85, ocr.confidence)
      : result === "manual_review"
      ? 0.5
      : 0.1;
    const extracted: Record<string, unknown> = {
      targetType: target.type,
      provider,
      ref: extractedReference,
      amount: amount.amount,
      amountReliable: amount.reliable,
      amountAmbiguous: amount.ambiguous,
      amountReason: amount.reason,
      amountEvidence: amount.evidence,
      date: receiptDateTime.date,
      time: receiptDateTime.instant?.toISOString() || null,
      timePh: receiptDateTime.wallTime,
      timeZone: "Asia/Manila",
      timeEncoding: "instant_utc_v2",
      targetStartedAt: startedAt?.toISOString() || null,
      receiptAgeMinutes,
      allowedEarlyMinutes: earlyToleranceMinutes,
      allowedPaymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
      expectedAmount: expected?.due ?? null,
      expectedTotal: expected?.total ?? null,
      expectedPaymentDetail: expected?.detail || null,
      pricingError,
      expectedRecipientNumber: maskNumber(merchant.number),
      expectedRecipientName: merchant.name || null,
      recipientStatus: recipient.status,
      recipientNumberStatus: recipient.numberStatus,
      recipientNameStatus: recipient.nameStatus,
      recipientNameMaskedByProvider: provider === "gcash" &&
        recipient.numberStatus === "match" &&
        recipient.nameStatus === "unreadable",
      recipientEvidence: recipient.evidence,
      ocrProvider: ocr.provider,
      ocrConfidence: ocr.confidence,
      ocrPrimaryError: ocr.primaryError,
      ocrFallbackError: ocr.fallbackError,
      ocrTextLength: ocr.text.length,
      rateLimitAvailable: attempt.available,
      attemptCountInWindow: attempt.count,
    };

    const auditError = await insertAudit(
      db,
      target,
      result,
      flags,
      extracted,
      confidence,
      imageHash,
      ocr.text,
    );
    if (auditError) {
      console.error("receipt verification audit insert failed:", auditError);
      addFlag(flags, "AUDIT_WRITE_FAILED");
      result = "manual_review";
    }

    const verifiedAt = new Date().toISOString();
    // Persist the screening result first. Strict, zero-flag GCash receipts are
    // promoted in a second transaction-safe RPC that also claims the reference
    // ledger; every other provider remains pending for owner review.
    const statusUpdate: Record<string, unknown> = target.type === "booking"
      ? result === "rejected"
        ? { status: "cancelled", payment_status: "rejected" }
        : { status: "pending", payment_status: "for_verification" }
      : result === "rejected"
      ? { payment_status: "rejected" }
      : { payment_status: "pending" };
    const finalUpdate = {
      ...statusUpdate,
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: null,
      receipt_status: result,
      receipt_flags: flags,
      receipt_extracted: extracted,
      receipt_confidence: confidence,
      receipt_verified_at: verifiedAt,
    };
    const finalized = await finalizeTarget(db, target, imageHash, finalUpdate);
    if (!finalized.updated) {
      console.error(
        "receipt final compare-and-set failed:",
        finalized.error || "no matching active row",
      );
      const current = await loadTarget(db, target.type, target.key);
      const currentTerminal = current ? terminalResponse(current) : null;
      if (currentTerminal) return currentTerminal;
      const currentFlags = Array.isArray(current?.row.receipt_flags)
        ? current.row.receipt_flags.map(String)
        : [];
      const currentSubmission = current &&
          !currentFlags.includes("VERIFICATION_IN_PROGRESS")
        ? submittedResponse(current)
        : null;
      if (currentSubmission) return currentSubmission;
      await sendTelegram(
        `⚠️ <b>RECEIPT PERSISTENCE NEEDS REVIEW</b>\n` +
          `Target: <code>${escapeHtml(target.ownerKey)}</code>\n` +
          `Customer: ${escapeHtml(target.row.full_name || "—")}\n` +
          "Evidence is stored, but the final screening state could not be saved. Review the target manually.",
      );
      return json({
        ok: false,
        status: "manual_review",
        flags: ["PERSISTENCE_FAILED"],
        publicReason:
          "Receipt stored, but final verification state could not be saved. Contact the owner.",
        receiptImageUrl: objectPath,
        receiptImageHash: imageHash,
        paymentConfirmed: false,
        requiresOwnerConfirmation: true,
      }, 503);
    }

    let autoConfirmed = false;
    let autoApproval: Record<string, unknown> | null = null;
    if (result === "auto_approved" && provider === "gcash") {
      const { data: approvalData, error: approvalError } = await db.rpc(
        "auto_approve_gcash_receipt",
        {
          p_target_type: target.type,
          p_target_key: target.key,
          p_payment_reference: typedReference,
          p_image_hash: imageHash,
        },
      );
      if (!approvalError) {
        autoApproval = Array.isArray(approvalData)
          ? (approvalData[0] || null)
          : approvalData;
        autoConfirmed = !!autoApproval;
      } else {
        console.error("automatic GCash approval failed:", errMsg(approvalError));
        const duplicateRace = errorCode(approvalError) === "23505";
        result = duplicateRace ? "rejected" : "manual_review";
        addFlag(
          flags,
          duplicateRace ? "DUPLICATE_REF" : "AUTO_APPROVAL_FAILED",
        );
        confidence = duplicateRace ? 0.1 : 0.5;
        const fallbackStatus = target.type === "booking"
          ? duplicateRace
            ? { status: "cancelled", payment_status: "rejected" }
            : { status: "pending", payment_status: "for_verification" }
          : duplicateRace
          ? { payment_status: "rejected" }
          : { payment_status: "pending" };
        const fallback = await finalizeTarget(db, target, imageHash, {
          ...fallbackStatus,
          receipt_status: result,
          receipt_flags: flags,
          receipt_confidence: confidence,
          receipt_verified_at: new Date().toISOString(),
        });
        if (!fallback.updated) {
          console.error(
            "automatic approval fallback failed:",
            fallback.error || "no matching active row",
          );
        }
        await insertAudit(
          db,
          target,
          result,
          flags,
          extracted,
          confidence,
          imageHash,
          ocr.text,
        );
      }
    }

    const heading = result === "rejected"
      ? "DUPLICATE PAYMENT REFERENCE REJECTED"
      : autoConfirmed
      ? "GCASH PAYMENT AUTO-APPROVED"
      : result === "auto_approved"
      ? "SCREENING PASSED — CONFIRM FUNDS"
      : "RECEIPT NEEDS REVIEW";
    const icon = result === "rejected"
      ? "❌"
      : autoConfirmed
      ? "✅"
      : result === "auto_approved"
      ? "🔎"
      : "⚠️";
    await sendTelegram(
      `${icon} <b>${heading}</b>\n` +
        `Target: <code>${escapeHtml(target.ownerKey)}</code>\n` +
        `Customer: ${escapeHtml(target.row.full_name || "—")}\n` +
        `Expected: ${
          expected ? `₱${expected.due.toFixed(2)}` : "pricing unavailable"
        }` +
        (amount.amount != null ? ` · Read: ₱${amount.amount.toFixed(2)}` : "") +
        "\n" +
        `Flags: <code>${escapeHtml(flags.join(", ") || "none")}</code>\n` +
        (autoConfirmed
          ? "The booking was confirmed automatically after every strict GCash check passed."
          : result === "auto_approved"
          ? "Action required: confirm the funds in the payment account before approving."
          : "Action required: review this receipt in the dashboard."),
    );

    if (auditError) {
      return json({
        ok: false,
        status: "manual_review",
        flags,
        publicReason:
          "Receipt stored for owner review, but the verification audit service was unavailable.",
        extracted,
        confidence,
        receiptImageUrl: objectPath,
        receiptImageHash: imageHash,
        receiptPhash: null,
        receiptVerifiedAt: verifiedAt,
        paymentConfirmed: false,
        requiresOwnerConfirmation: true,
      }, 503);
    }

    return json({
      ok: true,
      status: result,
      flags,
      publicReason: publicMessage(result, flags, autoConfirmed),
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: null,
      receiptVerifiedAt: verifiedAt,
      paymentConfirmed: autoConfirmed,
      requiresOwnerConfirmation: result !== "rejected" && !autoConfirmed,
      paymentStatus: autoApproval?.payment_status ||
        (result === "rejected" ? "rejected" : "for_verification"),
      bookingStatus: autoApproval?.booking_status ||
        (target.type === "booking"
          ? result === "rejected" ? "cancelled" : "pending"
          : null),
      message: publicMessage(result, flags, autoConfirmed),
    });
  } catch (error) {
    console.error("verify-gcash-receipt failed:", errMsg(error));
    return json({ error: "Receipt verification could not be completed" }, 500);
  }
});
