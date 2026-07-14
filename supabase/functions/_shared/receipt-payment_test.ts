import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveCourtPayment,
  deriveOpenPlayPayment,
} from "./receipt-payment.ts";

Deno.test("court pricing uses the court's hourly tiers and one flat fee", () => {
  const result = deriveCourtPayment({
    slots: [7, 18],
    courtRate: 100,
    courtRateSchedule: [{ from: 6, to: 18, rate: 100 }, {
      from: 18,
      to: 23,
      rate: 200,
    }],
    serviceFeeRate: 15,
    feeType: "flat",
    storedDue: 157.5,
    storedTotal: 315,
    acceptanceMode: "both",
  });
  assertEquals(result.total, 315);
  assertEquals(result.due, 157.5);
  assertEquals(result.fullyPaid, false);
  assertEquals(result.snapshotMismatch, false);
});

Deno.test("per-hour booking fee is derived server-side", () => {
  const result = deriveCourtPayment({
    slots: [8, 9],
    courtRate: 100,
    serviceFeeRate: 5,
    feeType: "per_hour",
    storedDue: 210,
    acceptanceMode: "full_payment_only",
  });
  assertEquals(result.total, 210);
  assertEquals(result.fullyPaid, true);
});

Deno.test("legacy booking fee type follows the public checkout's hourly behavior", () => {
  const result = deriveCourtPayment({
    slots: [9, 10],
    courtRate: 100,
    serviceFeeRate: 5,
    feeType: "booking",
    storedDue: 210,
    storedTotal: 210,
    acceptanceMode: "full_payment_only",
  });
  assertEquals(result.total, 210);
  assertEquals(result.detail.serviceFee, 10);
});

Deno.test("stored court amount outside full or half is rejected as pricing input", () => {
  assertThrows(() =>
    deriveCourtPayment({
      slots: [8],
      courtRate: 100,
      serviceFeeRate: 10,
      feeType: "flat",
      storedDue: 1,
      acceptanceMode: "both",
    })
  );
});

Deno.test("tiered Open Play fee is selected by persisted session key", () => {
  const result = deriveOpenPlayPayment({
    registration: {
      date: "2026-07-18",
      court_id: "c1",
      session_key: "night",
      session_start: 18,
      session_end: 22,
      amount: 65,
      base_fee: 120,
      system_fee: 10,
      total_due: 130,
    },
    settings: {
      open_play_config: JSON.stringify({
        enabled: true,
        days: [6],
        courtIds: ["c1"],
        sessions: [
          { key: "morning", start: 6, end: 10, fee: 80 },
          { key: "night", start: 18, end: 22, fee: 120 },
        ],
      }),
      maintenance_fee: "10",
      payment_acceptance_mode: "both",
    },
  });
  assertEquals(result.total, 130);
  assertEquals(result.due, 65);
  assertEquals(result.detail.sessionKey, "night");
  assertEquals(result.snapshotMismatch, false);
});

Deno.test("Open Play row cannot choose a cheaper unconfigured amount", () => {
  assertThrows(() =>
    deriveOpenPlayPayment({
      registration: {
        date: "2026-07-18",
        court_id: "c1",
        session_key: "night",
        amount: 20,
      },
      settings: {
        open_play_config: JSON.stringify({
          enabled: true,
          days: [6],
          sessions: [{ key: "night", start: 18, end: 22, fee: 120 }],
        }),
        maintenance_fee: "10",
        payment_acceptance_mode: "both",
      },
    })
  );
});
