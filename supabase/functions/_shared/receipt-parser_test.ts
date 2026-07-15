import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkRecipient,
  extractReceiptAmount,
  extractReference,
  normalizeReference,
  parseReceiptDateTime,
  providerEvidence,
} from "./receipt-parser.ts";

Deno.test("GCash reference is normalized and extracted from labelled OCR", () => {
  const text =
    "GCash Receipt\nReference No. 8041 8559 17375\nTotal Amount Sent PHP 500.00";
  assertEquals(
    extractReference(text, "gcash", "8041855917375"),
    "8041855917375",
  );
  assertEquals(normalizeReference("8041-8559-17375", "gcash"), "8041855917375");
});

Deno.test("bank reference preserves alphanumeric characters", () => {
  const text =
    "GoTyme Transfer Successful\nTransaction Reference: GT-AB12-9087";
  assertEquals(extractReference(text, "gotyme", "GTAB129087"), "GTAB129087");
});

Deno.test("labelled principal amount is reliable and fee is ignored", () => {
  const result = extractReceiptAmount(
    "Transfer successful\nAmount sent: PHP 1,250.00\nService fee PHP 15.00",
  );
  assertEquals(result.amount, 1250);
  assertEquals(result.reliable, true);
  assertEquals(result.ambiguous, false);
});

Deno.test("currency-only amount remains manual-review quality", () => {
  const result = extractReceiptAmount("GCash receipt\nPHP 600.00");
  assertEquals(result.amount, 600);
  assertEquals(result.reliable, false);
});

Deno.test("date-only OCR does not invent midnight time", () => {
  const parsed = parseReceiptDateTime("Paid on Jul 13, 2026");
  assertEquals(parsed.date, "2026-07-13");
  assertEquals(parsed.wallTime, null);
  assertEquals(parsed.instant, null);
  assertEquals(parsed.shifted, null);
});

Deno.test("receipt timestamp is parsed as Philippine wall clock", () => {
  const parsed = parseReceiptDateTime("Jul 13, 2026 9:42 PM");
  assertEquals(parsed.date, "2026-07-13");
  assertEquals(parsed.wallTime, "21:42");
  assertEquals(parsed.instant?.toISOString(), "2026-07-13T13:42:00.000Z");
  assertEquals(parsed.shifted?.toISOString(), "2026-07-13T21:42:00.000Z");
});

Deno.test("GCash morning receipt preserves 11:50 AM Philippine time", () => {
  const parsed = parseReceiptDateTime("Ref No. 2042905298438 Jul 15, 2026 11:50 AM");
  assertEquals(parsed.date, "2026-07-15");
  assertEquals(parsed.wallTime, "11:50");
  assertEquals(parsed.instant?.toISOString(), "2026-07-15T03:50:00.000Z");
  assertEquals(parsed.shifted?.toISOString(), "2026-07-15T11:50:00.000Z");
});

Deno.test("recipient last four only matches inside a labelled recipient field", () => {
  const unrelated = checkRecipient(
    "Reference 1234567895766\nSent to AN**** A.",
    "0952 482 5766",
    "Annaliza Acero",
  );
  assertEquals(unrelated.numberStatus, "unreadable");

  const labelled = checkRecipient(
    "Recipient mobile: 09** *** 5766",
    "0952 482 5766",
    "Annaliza Acero",
  );
  assertEquals(labelled.numberStatus, "match");
});

Deno.test("different complete labelled recipient is deterministic", () => {
  const result = checkRecipient(
    "Sent to: 09171234567",
    "09524825766",
    "CourtYard Pickleball",
  );
  assertEquals(result.status, "wrong");
  assertEquals(result.numberStatus, "wrong");
});

Deno.test("GCash masked receipt header matches the configured full number", () => {
  const result = checkRecipient(
    "Amount\nAN.....A A.\n+63 952 482 5766\nSent via GCash\nTotal Amount Sent\n1.00",
    "09524825766",
    "ANNALIZA ACERO",
  );
  assertEquals(result.status, "match");
  assertEquals(result.numberStatus, "match");
  assertEquals(result.nameStatus, "unreadable");
});

Deno.test("GCash masked receipt header still rejects a different full number", () => {
  const result = checkRecipient(
    "Amount\nAN.....A A.\n+63 917 123 4567\nSent via GCash\nTotal Amount Sent\n1.00",
    "09524825766",
    "ANNALIZA ACERO",
  );
  assertEquals(result.status, "wrong");
  assertEquals(result.numberStatus, "wrong");
});

Deno.test("provider evidence detects an explicitly different bank", () => {
  assertEquals(providerEvidence("GoTyme transfer successful", "gcash"), {
    expected: false,
    conflicting: "gotyme",
  });
});
