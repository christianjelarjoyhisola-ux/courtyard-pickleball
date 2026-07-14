import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  constantTimeAsciiEqual,
  isReceiptToken,
  providerLedgerKey,
  receiptTokenMatches,
  routeReceiptDecision,
  sha256Utf8Hex,
} from "./receipt-security.ts";

Deno.test("receipt token format matches the database capability contract", () => {
  assertEquals(isReceiptToken("A".repeat(43)), true);
  assertEquals(isReceiptToken("A".repeat(42)), false);
  assertEquals(isReceiptToken(`${"A".repeat(42)}=`), false);
  assertEquals(isReceiptToken(`${"A".repeat(42)}+`), false);
});

Deno.test("receipt token hashes exact UTF-8 bytes", async () => {
  const token = "QmFzZTY0dXJsX3Rva2VuLWFiYzEyMw";
  const hash = await sha256Utf8Hex(token);
  assertEquals(await receiptTokenMatches(token, hash), true);
  assertEquals(await receiptTokenMatches(`${token} `, hash), false);
  assertEquals(await receiptTokenMatches(token.toLowerCase(), hash), false);
  assertEquals(await receiptTokenMatches(token, hash.toUpperCase()), false);
});

Deno.test("constant-time comparison includes length", () => {
  assertEquals(constantTimeAsciiEqual("abc", "abc"), true);
  assertEquals(constantTimeAsciiEqual("abc", "abd"), false);
  assertEquals(constantTimeAsciiEqual("abc", "abc0"), false);
});

Deno.test("ledger references are provider namespaced", () => {
  assertEquals(providerLedgerKey("GCash", "123"), "gcash:123");
  assertEquals(providerLedgerKey("pnb", "ABC123"), "pnb:ABC123");
});

Deno.test("only a database-confirmed duplicate reference rejects", () => {
  assertEquals(routeReceiptDecision([]), "auto_approved");
  assertEquals(routeReceiptDecision(["OCR_UNAVAILABLE"]), "manual_review");
  assertEquals(routeReceiptDecision(["IMAGE_UNREADABLE"]), "manual_review");
  assertEquals(routeReceiptDecision(["PRICING_ERROR"]), "manual_review");
  assertEquals(routeReceiptDecision(["REF_MISMATCH"]), "manual_review");
  assertEquals(routeReceiptDecision(["WRONG_RECIPIENT"]), "manual_review");
  assertEquals(
    routeReceiptDecision(["AMOUNT_MISMATCH", "LOW_OCR_CONFIDENCE"]),
    "manual_review",
  );
  assertEquals(
    routeReceiptDecision(["DUPLICATE_REF", "LOW_OCR_CONFIDENCE"]),
    "rejected",
  );
});
