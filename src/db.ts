import Database from "better-sqlite3";
import { appConfig } from "./config.js";
import type { Order, OrderStatus, Product, ReminderType } from "./types.js";

const db = new Database(appConfig.DATABASE_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  stars_price INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  traffic_limit_gb INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  telegram_username TEXT,
  product_id INTEGER NOT NULL,
  amount_stars INTEGER NOT NULL,
  payload TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
  remnawave_user_uuid TEXT,
  remnawave_short_uuid TEXT,
  subscription_url TEXT,
  expires_at TEXT,
  payment_charge_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS trials (
  telegram_user_id INTEGER PRIMARY KEY,
  remnawave_user_uuid TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('H24', 'H1')),
  sent_at TEXT NOT NULL,
  UNIQUE(order_id, reminder_type),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS user_state (
  telegram_user_id INTEGER PRIMARY KEY,
  panel_message_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_report_log (
  report_date TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status_updated_at ON orders(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_tg_status ON orders(telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_charge_id ON orders(payment_charge_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_payment_charge_id_not_null ON orders(payment_charge_id) WHERE payment_charge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_rw_uuid ON orders(remnawave_user_uuid);
CREATE INDEX IF NOT EXISTS idx_trials_created_at ON trials(created_at);
`);

const orderColumns = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
const orderColumnNames = new Set(orderColumns.map((c) => c.name));
if (!orderColumnNames.has("invoice_chat_id")) {
  db.exec("ALTER TABLE orders ADD COLUMN invoice_chat_id INTEGER;");
}
if (!orderColumnNames.has("invoice_message_id")) {
  db.exec("ALTER TABLE orders ADD COLUMN invoice_message_id INTEGER;");
}
if (!orderColumnNames.has("invoice_expires_at")) {
  db.exec("ALTER TABLE orders ADD COLUMN invoice_expires_at TEXT;");
}

const basePlanCode = "OBSYDO_MONTH_200";
const basePlan = db.prepare("SELECT id FROM products WHERE code = ?").get(basePlanCode) as { id: number } | undefined;
if (!basePlan) {
  db.prepare(`
    INSERT INTO products (code, title, description, stars_price, duration_days, traffic_limit_gb, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    basePlanCode,
    "OBSYDO VPN 30 дней",
    "Основной тариф OBSYDO VPN: 30 дней, 300 GB, продление суммируется",
    appConfig.DEFAULT_PLAN_PRICE_STARS,
    appConfig.DEFAULT_PLAN_DURATION_DAYS,
    appConfig.DEFAULT_TRAFFIC_GB
  );
} else {
  db.prepare(`
    UPDATE products
    SET title = ?, description = ?, stars_price = ?, duration_days = ?, traffic_limit_gb = ?, is_active = 1
    WHERE code = ?
  `).run(
    "OBSYDO VPN 30 дней",
    "Основной тариф OBSYDO VPN: 30 дней, 300 GB, продление суммируется",
    appConfig.DEFAULT_PLAN_PRICE_STARS,
    appConfig.DEFAULT_PLAN_DURATION_DAYS,
    appConfig.DEFAULT_TRAFFIC_GB,
    basePlanCode
  );
}
db.prepare("UPDATE products SET is_active = 0 WHERE code <> ?").run(basePlanCode);

function mapProduct(row: any): Product {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    starsPrice: row.stars_price,
    durationDays: row.duration_days,
    trafficLimitGb: row.traffic_limit_gb,
    isActive: row.is_active
  };
}

function mapOrder(row: any): Order {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
    productId: row.product_id,
    amountStars: row.amount_stars,
    payload: row.payload,
    status: row.status,
    remnawaveUserUuid: row.remnawave_user_uuid,
    remnawaveShortUuid: row.remnawave_short_uuid,
    subscriptionUrl: row.subscription_url,
    expiresAt: row.expires_at,
    paymentChargeId: row.payment_charge_id,
    invoiceChatId: row.invoice_chat_id ?? null,
    invoiceMessageId: row.invoice_message_id ?? null,
    invoiceExpiresAt: row.invoice_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const repo = {
  getActiveProducts(): Product[] {
    const rows = db.prepare("SELECT * FROM products WHERE is_active = 1 ORDER BY stars_price ASC").all();
    return rows.map(mapProduct);
  },
  getAllProducts(): Product[] {
    const rows = db.prepare("SELECT * FROM products ORDER BY id ASC").all();
    return rows.map(mapProduct);
  },
  getProductById(id: number): Product | null {
    const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    return row ? mapProduct(row) : null;
  },
  toggleProduct(id: number): Product | null {
    db.prepare("UPDATE products SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?").run(id);
    return this.getProductById(id);
  },
  createProduct(input: Omit<Product, "id" | "isActive">): Product {
    db.prepare(`
      INSERT INTO products (code, title, description, stars_price, duration_days, traffic_limit_gb, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(input.code, input.title, input.description, input.starsPrice, input.durationDays, input.trafficLimitGb);
    return this.getProductByCode(input.code)!;
  },
  getProductByCode(code: string): Product | null {
    const row = db.prepare("SELECT * FROM products WHERE code = ?").get(code);
    return row ? mapProduct(row) : null;
  },
  updateProductByCode(input: {
    code: string;
    title?: string;
    description?: string;
    starsPrice?: number;
    durationDays?: number;
    trafficLimitGb?: number;
  }): Product | null {
    const current = this.getProductByCode(input.code);
    if (!current) return null;
    db.prepare(`
      UPDATE products
      SET title = ?,
          description = ?,
          stars_price = ?,
          duration_days = ?,
          traffic_limit_gb = ?
      WHERE code = ?
    `).run(
      input.title ?? current.title,
      input.description ?? current.description,
      input.starsPrice ?? current.starsPrice,
      input.durationDays ?? current.durationDays,
      input.trafficLimitGb ?? current.trafficLimitGb,
      input.code
    );
    return this.getProductByCode(input.code);
  },
  createPendingOrder(input: {
    telegramUserId: number;
    telegramUsername: string | null;
    productId: number;
    amountStars: number;
    payload: string;
  }): Order {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO orders (telegram_user_id, telegram_username, product_id, amount_stars, payload, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(input.telegramUserId, input.telegramUsername, input.productId, input.amountStars, input.payload, now, now);
    return this.getOrderByPayload(input.payload)!;
  },
  getOrderByPayload(payload: string): Order | null {
    const row = db.prepare("SELECT * FROM orders WHERE payload = ?").get(payload);
    return row ? mapOrder(row) : null;
  },
  getOrderByPaymentChargeId(paymentChargeId: string): Order | null {
    const row = db.prepare("SELECT * FROM orders WHERE payment_charge_id = ?").get(paymentChargeId);
    return row ? mapOrder(row) : null;
  },
  setInvoiceMeta(input: {
    payload: string;
    invoiceChatId: number;
    invoiceMessageId: number;
    invoiceExpiresAt: string;
  }): void {
    db.prepare(`
      UPDATE orders
      SET invoice_chat_id = ?,
          invoice_message_id = ?,
          invoice_expires_at = ?,
          updated_at = ?
      WHERE payload = ? AND status = 'PENDING'
    `).run(
      input.invoiceChatId,
      input.invoiceMessageId,
      input.invoiceExpiresAt,
      new Date().toISOString(),
      input.payload
    );
  },
  getExpiredPendingOrders(nowIso: string): Order[] {
    const fallbackCreatedBeforeIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM orders
         WHERE status = 'PENDING'
           AND (
             (invoice_expires_at IS NOT NULL AND invoice_expires_at <= ?)
             OR (invoice_expires_at IS NULL AND created_at <= ?)
           )`
      )
      .all(nowIso, fallbackCreatedBeforeIso);
    return rows.map(mapOrder);
  },
  deletePendingOrderById(orderId: number): void {
    db.prepare("DELETE FROM orders WHERE id = ? AND status = 'PENDING'").run(orderId);
  },
  markOrderPaid(input: {
    payload: string;
    paymentChargeId: string;
    remnawaveUserUuid: string;
    remnawaveShortUuid: string;
    subscriptionUrl: string;
    expiresAt: string;
  }): Order | null {
    const now = new Date().toISOString();
    try {
      const info = db.prepare(`
        UPDATE orders
        SET status = 'PAID',
            payment_charge_id = ?,
            remnawave_user_uuid = ?,
            remnawave_short_uuid = ?,
            subscription_url = ?,
            expires_at = ?,
            updated_at = ?,
            invoice_chat_id = NULL,
            invoice_message_id = NULL,
            invoice_expires_at = NULL
        WHERE payload = ? AND status = 'PENDING'
      `).run(
        input.paymentChargeId,
        input.remnawaveUserUuid,
        input.remnawaveShortUuid,
        input.subscriptionUrl,
        input.expiresAt,
        now,
        input.payload
      );
      if (info.changes === 0) return null;
      return this.getOrderByPayload(input.payload);
    } catch (error: any) {
      if (String(error?.message ?? "").includes("UNIQUE constraint failed: orders.payment_charge_id")) {
        return null;
      }
      throw error;
    }
  },
  getOrderById(id: number): Order | null {
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return row ? mapOrder(row) : null;
  },
  markOrderFailed(payload: string): void {
    db.prepare("UPDATE orders SET status = 'FAILED', updated_at = ? WHERE payload = ?").run(
      new Date().toISOString(),
      payload
    );
  },
  getPaidUserIds(): number[] {
    const rows = db
      .prepare("SELECT DISTINCT telegram_user_id FROM orders WHERE status = 'PAID'")
      .all() as Array<{ telegram_user_id: number }>;
    return rows.map((r) => r.telegram_user_id);
  },
  hasDailyReport(reportDate: string): boolean {
    const row = db
      .prepare("SELECT 1 as ok FROM daily_report_log WHERE report_date = ?")
      .get(reportDate) as { ok: number } | undefined;
    return Boolean(row?.ok);
  },
  markDailyReportSent(reportDate: string): void {
    db.prepare("INSERT OR IGNORE INTO daily_report_log (report_date, sent_at) VALUES (?, ?)").run(
      reportDate,
      new Date().toISOString()
    );
  },
  getNewOrdersCountBetween(startIso: string, endIso: string): number {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ?")
      .get(startIso, endIso) as { count: number };
    return row.count;
  },
  getPaidOrdersCountBetween(startIso: string, endIso: string): number {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'PAID' AND updated_at >= ? AND updated_at < ?")
      .get(startIso, endIso) as { count: number };
    return row.count;
  },
  getRevenueStarsBetween(startIso: string, endIso: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(amount_stars), 0) as total FROM orders WHERE status = 'PAID' AND updated_at >= ? AND updated_at < ?"
      )
      .get(startIso, endIso) as { total: number };
    return row.total ?? 0;
  },
  getNewTrialsCountBetween(startIso: string, endIso: string): number {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM trials WHERE created_at >= ? AND created_at < ?")
      .get(startIso, endIso) as { count: number };
    return row.count;
  },
  getActivePaidSubscriptionsCount(nowIso: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM (SELECT telegram_user_id, MAX(expires_at) AS max_exp FROM orders WHERE status = 'PAID' GROUP BY telegram_user_id) t WHERE max_exp IS NOT NULL AND max_exp > ?"
      )
      .get(nowIso) as { count: number };
    return row.count;
  },
  getTopProductsBetween(startIso: string, endIso: string, limit = 5): Array<{ title: string; count: number; revenue: number }> {
    const rows = db
      .prepare(
        `SELECT p.title as title, COUNT(*) as count, COALESCE(SUM(o.amount_stars), 0) as revenue
         FROM orders o
         JOIN products p ON p.id = o.product_id
         WHERE o.status = 'PAID' AND o.updated_at >= ? AND o.updated_at < ?
         GROUP BY o.product_id
         ORDER BY revenue DESC
         LIMIT ?`
      )
      .all(startIso, endIso, limit) as Array<{ title: string; count: number; revenue: number }>;
    return rows;
  },
  setPanelMessageId(telegramUserId: number, panelMessageId: number): void {
    db.prepare(`
      INSERT INTO user_state (telegram_user_id, panel_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        panel_message_id = excluded.panel_message_id,
        updated_at = excluded.updated_at
    `).run(telegramUserId, panelMessageId, new Date().toISOString());
  },
  getPanelMessageId(telegramUserId: number): number | null {
    const row = db
      .prepare("SELECT panel_message_id FROM user_state WHERE telegram_user_id = ?")
      .get(telegramUserId) as { panel_message_id: number | null } | undefined;
    return row?.panel_message_id ?? null;
  },
  getLatestPaidOrderForUser(telegramUserId: number): Order | null {
    const row = db
      .prepare("SELECT * FROM orders WHERE telegram_user_id = ? AND status = 'PAID' ORDER BY id DESC LIMIT 1")
      .get(telegramUserId);
    return row ? mapOrder(row) : null;
  },
  hasUsedTrial(telegramUserId: number): boolean {
    const row = db.prepare("SELECT 1 as ok FROM trials WHERE telegram_user_id = ?").get(telegramUserId) as
      | { ok: number }
      | undefined;
    return Boolean(row?.ok);
  },
  saveTrial(input: { telegramUserId: number; remnawaveUserUuid: string; expiresAt: string }): void {
    db.prepare(`
      INSERT INTO trials (telegram_user_id, remnawave_user_uuid, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.telegramUserId, input.remnawaveUserUuid, input.expiresAt, new Date().toISOString());
  },
  getPaidOrdersForReminders(): Order[] {
    const rows = db
      .prepare("SELECT * FROM orders WHERE status = 'PAID' AND expires_at IS NOT NULL ORDER BY id DESC")
      .all();
    return rows.map(mapOrder);
  },
  getPaidOrdersForReconcile(limit = 200): Order[] {
    const rows = db
      .prepare("SELECT * FROM orders WHERE status = 'PAID' ORDER BY id DESC LIMIT ?")
      .all(limit);
    return rows.map(mapOrder);
  },
  syncPaidOrderFromRemnawave(input: {
    orderId: number;
    remnawaveUserUuid: string;
    remnawaveShortUuid: string;
    subscriptionUrl: string;
    expiresAt: string;
  }): void {
    db.prepare(`
      UPDATE orders
      SET remnawave_user_uuid = ?,
          remnawave_short_uuid = ?,
          subscription_url = ?,
          expires_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'PAID'
    `).run(
      input.remnawaveUserUuid,
      input.remnawaveShortUuid,
      input.subscriptionUrl,
      input.expiresAt,
      new Date().toISOString(),
      input.orderId
    );
  },
  hasReminder(orderId: number, reminderType: ReminderType): boolean {
    const row = db
      .prepare("SELECT 1 as ok FROM reminder_log WHERE order_id = ? AND reminder_type = ?")
      .get(orderId, reminderType) as { ok: number } | undefined;
    return Boolean(row?.ok);
  },
  markReminderSent(orderId: number, reminderType: ReminderType): void {
    db.prepare("INSERT OR IGNORE INTO reminder_log (order_id, reminder_type, sent_at) VALUES (?, ?, ?)").run(
      orderId,
      reminderType,
      new Date().toISOString()
    );
  },
  stats(): { products: number; pending: number; paid: number; totalRevenueStars: number } {
    const products = (db.prepare("SELECT COUNT(*) as count FROM products").get() as any).count as number;
    const pending = (db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'PENDING'").get() as any)
      .count as number;
    const paid = (db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'PAID'").get() as any)
      .count as number;
    const totalRevenueStars = ((db
      .prepare("SELECT COALESCE(SUM(amount_stars), 0) as total FROM orders WHERE status = 'PAID'")
      .get() as any).total ?? 0) as number;
    return { products, pending, paid, totalRevenueStars };
  },
  recentOrders(limit = 10): Order[] {
    const rows = db
      .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?")
      .all(limit);
    return rows.map(mapOrder);
  },
  setOrderStatus(payload: string, status: OrderStatus): void {
    db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE payload = ?").run(
      status,
      new Date().toISOString(),
      payload
    );
  },
  async backupTo(filePath: string): Promise<void> {
    await db.backup(filePath);
  }
};
