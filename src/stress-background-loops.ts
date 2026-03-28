/**
 * Stress-test for background-loop DB paths (same queries as bot.ts loops).
 * Uses a throwaway SQLite file; does not call Telegram or Remnawave.
 *
 * Run: npx tsx src/stress-background-loops.ts
 * Requires valid .env (or env vars) for config schema except DATABASE_PATH is overridden.
 */
import { config as loadEnv } from "dotenv";
import path from "path";
import fs from "fs";

loadEnv();

const PASSES = 80;
const BATCH_DELETE = 40;

function cleanupDbFiles(dbFile: string) {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbFile + ext);
    } catch {
      // ignore
    }
  }
}

/** Mirrors bot.ts reminder windows (must stay in sync). */
function reminderWouldFireH24(diffMs: number): boolean {
  return diffMs <= 24 * 60 * 60 * 1000 && diffMs > 23 * 60 * 60 * 1000;
}
function reminderWouldFireH1(diffMs: number): boolean {
  return diffMs <= 60 * 60 * 1000 && diffMs > 50 * 60 * 1000;
}

async function main() {
  const dbFile = path.join(process.cwd(), `stress-bg-${Date.now()}.sqlite`);
  process.env.DATABASE_PATH = dbFile;

  const { repo } = await import("./db.js");
  const { appConfig } = await import("./config.js");

  const products = repo.getActiveProducts();
  if (!products.length) throw new Error("No active products to seed stress data");
  const productId = products[0].id;
  const now = Date.now();
  const oldIso = new Date(now - 15 * 60 * 1000).toISOString();
  const trialExpiredIso = new Date(now - 5 * 60 * 1000).toISOString();
  const paidExpiredIso = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const futureIso = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log("Seeding stress data…");

  for (let i = 0; i < 400; i++) {
    const o = repo.createPendingOrder({
      telegramUserId: 5_000_000 + i,
      telegramUsername: i % 7 === 0 ? `u${i}` : null,
      productId,
      amountStars: products[0].starsPrice,
      payload: `stress:inv:${i}:${now}`
    });
    repo.setInvoiceMeta({
      payload: o.payload,
      invoiceChatId: 100000 + i,
      invoiceMessageId: 200000 + i,
      invoiceExpiresAt: oldIso
    });
  }

  for (let i = 0; i < 200; i++) {
    repo.saveTrial({
      telegramUserId: 6_000_000 + i,
      remnawaveUserUuid: `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
      expiresAt: trialExpiredIso
    });
  }

  for (let i = 0; i < 150; i++) {
    const tg = 7_000_000 + i;
    repo.upsertTrafficCycleOnPayment({
      telegramUserId: tg,
      remnawaveUserUuid: `10000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
      resetAnchor: true
    });
    repo.markTrafficCycleReset({
      telegramUserId: tg,
      nextResetAt: oldIso
    });
  }

  for (let i = 0; i < 250; i++) {
    const p = repo.createPendingOrder({
      telegramUserId: 8_000_000 + i,
      telegramUsername: null,
      productId,
      amountStars: products[0].starsPrice,
      payload: `stress:paidp:${i}:${now}`
    });
    repo.markOrderPaid({
      payload: p.payload,
      paymentChargeId: `stress-ch-${i}-${now}`,
      remnawaveUserUuid: `20000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
      remnawaveShortUuid: `s${i}`,
      subscriptionUrl: `https://example.com/s/${i}`,
      expiresAt: i % 5 === 0 ? futureIso : paidExpiredIso
    });
  }

  const h24Target = new Date(now + 23.5 * 60 * 60 * 1000).toISOString();
  const pH24 = repo.createPendingOrder({
    telegramUserId: 9_000_001,
    telegramUsername: null,
    productId,
    amountStars: products[0].starsPrice,
    payload: `stress:h24:${now}`
  });
  repo.markOrderPaid({
    payload: pH24.payload,
    paymentChargeId: `stress-ch-h24-${now}`,
    remnawaveUserUuid: "30000000-0000-4000-8000-000000000001",
    remnawaveShortUuid: "h24",
    subscriptionUrl: "https://example.com/h24",
    expiresAt: h24Target
  });

  const reportLabel = `stress-daily-${now}`;

  console.log(`DB file: ${dbFile}`);
  console.log(`Starting ${PASSES} passes × loop queries (batch delete up to ${BATCH_DELETE} invoices/pass)…`);

  const t0 = Date.now();
  let invoiceDeletes = 0;
  let trafficMarks = 0;
  let trialDeletes = 0;
  let reminderScans = 0;

  for (let pass = 0; pass < PASSES; pass++) {
    const nowIso = new Date().toISOString();

    const expired = repo.getExpiredPendingOrders(nowIso);
    for (const o of expired.slice(0, BATCH_DELETE)) {
      repo.deletePendingOrderById(o.id);
      invoiceDeletes++;
    }

    const dueCycles = repo.getDueTrafficCycles(nowIso, 500);
    for (const c of dueCycles) {
      let nextResetAt = c.nextResetAt;
      while (new Date(nextResetAt).getTime() <= Date.now()) {
        nextResetAt = repo.addDaysIso(nextResetAt, 30);
      }
      repo.markTrafficCycleReset({ telegramUserId: c.telegramUserId, nextResetAt });
      trafficMarks++;
    }

    const trialCutoffIso = new Date(Date.now() - 60 * 1000).toISOString();
    const trials = repo.getTrialsDueForAutoDelete(trialCutoffIso);
    for (const t of trials.slice(0, 30)) {
      repo.deleteTrialByTelegramId(t.telegramUserId);
      trialDeletes++;
    }

    const paidCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    repo.getPaidUsersDueForAutoDelete(paidCutoffIso);

    const ordersRem = repo.getPaidOrdersForReminders();
    reminderScans++;
    const scanNow = Date.now();
    for (const order of ordersRem) {
      if (!order.expiresAt) continue;
      const expiresAtMs = new Date(order.expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) continue;
      const diff = expiresAtMs - scanNow;
      void reminderWouldFireH24(diff);
      void reminderWouldFireH1(diff);
    }

    const rec = repo.getPaidOrdersForReconcile(Math.min(appConfig.RECONCILE_LIMIT, 500));
    const first = rec[0];
    if (first) {
      repo.syncPaidOrderFromRemnawave({
        orderId: first.id,
        remnawaveUserUuid: first.remnawaveUserUuid ?? "20000000-0000-4000-a000-000000000099",
        remnawaveShortUuid: first.remnawaveShortUuid ?? "x",
        subscriptionUrl: first.subscriptionUrl ?? "https://example.com/x",
        expiresAt: first.expiresAt ?? futureIso
      });
    }

    repo.getNewOrdersCountBetween(oldIso, nowIso);
    repo.getPaidOrdersCountBetween(oldIso, nowIso);
    repo.getRevenueStarsBetween(oldIso, nowIso);
    repo.getTopProductsBetween(oldIso, nowIso, 5);
    repo.getActivePaidSubscriptionsCount(nowIso);
    repo.getLatestPaidOrderForUser(8_000_000);
    repo.getLatestPaidOrderForUser(8_000_042);

    if (!repo.hasDailyReport(reportLabel)) {
      repo.markDailyReportSent(reportLabel);
    }

    repo.stats();
  }

  console.log("Parallel read burst (8×50 concurrent tasks)…");
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let i = 0; i < 50; i++) {
        const iso = new Date().toISOString();
        repo.getExpiredPendingOrders(iso);
        repo.getDueTrafficCycles(iso, 300);
        repo.getTrialsDueForAutoDelete(iso);
        repo.getPaidUsersDueForAutoDelete(iso);
        repo.getPaidOrdersForReminders();
        repo.getPaidOrdersForReconcile(200);
        repo.stats();
      }
    })
  );

  const ms = Date.now() - t0;
  const st = repo.stats();

  console.log("\n--- Stress summary ---");
  console.log(`Passes: ${PASSES}, wall time: ${ms} ms (${(ms / PASSES).toFixed(1)} ms/pass)`);
  console.log(`Invoice deletes (cumulative): ${invoiceDeletes}`);
  console.log(`Traffic cycle marks (cumulative): ${trafficMarks}`);
  console.log(`Trial deletes (cumulative): ${trialDeletes}`);
  console.log(`Reminder full scans: ${reminderScans}`);
  console.log(`Final repo.stats():`, st);
  console.log(`Pending orders left: ${st.pending}, paid: ${st.paid}`);

  cleanupDbFiles(dbFile);
  console.log("\nSTRESS_BACKGROUND_LOOPS_OK (temp DB removed)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
