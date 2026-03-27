import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { appConfig } from "./config.js";
import { repo } from "./db.js";
import { RemnawaveClient } from "./remnawave.js";

const rw = new RemnawaveClient();
const bot = new Telegraf(appConfig.BOT_TOKEN);
const INVOICE_TTL_MINUTES = 10;

type AdminDangerAction = "ENABLE" | "DISABLE" | "RESET" | "REVOKE" | "DELETE";
type PendingAdminAction = {
  adminId: number;
  targetTelegramId: number;
  targetUuid: string;
  action: AdminDangerAction;
  createdAt: number;
};
const pendingAdminActions = new Map<string, PendingAdminAction>();
type AdminInputMode = "FIND_USER" | "BROADCAST";
type AdminInputState = {
  adminId: number;
  mode: AdminInputMode;
  createdAt: number;
};
const adminInputStates = new Map<number, AdminInputState>();

function isAdmin(ctx: Context): boolean {
  const tgId = ctx.from?.id;
  return typeof tgId === "number" && appConfig.adminIds.includes(tgId);
}

function makeUsername(ctx: Context): string {
  const tgId = String(ctx.from?.id ?? Date.now());
  const rawNick = (ctx.from?.username ?? "tg")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const nick = rawNick.length > 0 ? rawNick : "tg";
  const maxNickLen = Math.max(3, 36 - tgId.length - 1); // "_" between nickname and id
  const nickPart = nick.slice(0, maxNickLen);
  return `${nickPart}_${tgId}`.slice(0, 36);
}

function formatTraffic(gb: number): string {
  return gb === 0 ? "Безлимит" : `${gb} GB`;
}

function toMoscow(iso: string | null): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: appConfig.TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(d);
}

function getMoscowDateTimeLabel(date = new Date()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: appConfig.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function getUtcRangeForMoscowDay(dayOffset = 0): { startIso: string; endIso: string; label: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appConfig.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const utcMidnight = new Date(Date.UTC(y, m - 1, d));
  const targetMidnightUtc = new Date(utcMidnight.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const moscowOffsetMs = 3 * 60 * 60 * 1000;
  const startIso = new Date(targetMidnightUtc.getTime() - moscowOffsetMs).toISOString();
  const endIso = new Date(targetMidnightUtc.getTime() + 24 * 60 * 60 * 1000 - moscowOffsetMs).toISOString();
  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone: appConfig.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(targetMidnightUtc.getTime() + 12 * 60 * 60 * 1000));
  return { startIso, endIso, label };
}

async function safeDelete(chatId: number, messageId: number) {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch {
    // Ignore cleanup errors.
  }
}

async function transientReply(ctx: Context, text: string, seconds = 12) {
  if (!ctx.chat) return;
  const msg = await ctx.reply(text);
  setTimeout(() => {
    void safeDelete(ctx.chat!.id, msg.message_id);
  }, seconds * 1000);
}

async function notifyAdmins(text: string) {
  for (const adminId of appConfig.adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, `#ALERT\n${text}`);
    } catch {
      // Keep loop alive for other admins.
    }
  }
}

function adminCommandsHelpText(): string {
  return (
    "Админ-команды:\n\n" +
    "/admin - админ-панель\n" +
    "/stats - сводная статистика\n" +
    "/orders [N] - последние N заказов\n" +
    "/finduser <telegramId> - найти пользователя по Telegram ID\n" +
    "/plansadmin - список тарифов с code\n" +
    "/setprice <code> <stars> - изменить цену тарифа\n" +
    "/editplan <code>|<title>|<description>|<stars>|<days>|<trafficGb> - полное редактирование тарифа\n" +
    "/grantdays <telegramId> <days> - продлить на N дней\n" +
    "/enable <telegramId> - включить пользователя (с подтверждением)\n" +
    "/disable <telegramId> - выключить пользователя (с подтверждением)\n" +
    "/reset <telegramId> - сбросить трафик (с подтверждением)\n" +
    "/revoke <telegramId> - отозвать подписку (с подтверждением)\n" +
    "/delete <telegramId> - удалить пользователя (с подтверждением)\n" +
    "/broadcast <текст> - рассылка платным пользователям\n" +
    "/reconcile - ручная сверка с Remnawave\n" +
    "/dailyreport - ручная отправка ежедневной сводки"
  );
}

function adminPanelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Статистика", "admin:stats"), Markup.button.callback("Последние заказы", "admin:orders")],
    [Markup.button.callback("Тарифы", "admin:products"), Markup.button.callback("Инструкции", "admin:help")],
    [Markup.button.callback("Найти пользователя", "admin:user:lookup"), Markup.button.callback("Рассылка", "admin:broadcast:prompt")]
  ]);
}

function compactId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function setAdminInput(adminId: number, mode: AdminInputMode) {
  adminInputStates.set(adminId, { adminId, mode, createdAt: Date.now() });
}

function clearAdminInput(adminId: number) {
  adminInputStates.delete(adminId);
}

function getAdminInput(adminId: number): AdminInputState | null {
  const state = adminInputStates.get(adminId);
  if (!state) return null;
  if (Date.now() - state.createdAt > 10 * 60 * 1000) {
    adminInputStates.delete(adminId);
    return null;
  }
  return state;
}

async function requestDangerActionConfirm(
  ctx: Context,
  action: AdminDangerAction,
  targetTelegramId: number
): Promise<void> {
  if (!ctx.from || !isAdmin(ctx)) return;
  const rwUser = await rw.getByTelegramId(targetTelegramId);
  if (!rwUser) {
    await ctx.reply("Пользователь не найден в Remnawave.");
    return;
  }
  const id = compactId();
  pendingAdminActions.set(id, {
    adminId: ctx.from.id,
    targetTelegramId,
    targetUuid: rwUser.uuid,
    action,
    createdAt: Date.now()
  });
  await ctx.reply(
    `Подтвердите действие:\n` +
      `- action: ${action}\n` +
      `- telegramId: ${targetTelegramId}\n` +
      `- uuid: ${rwUser.uuid}\n\n` +
      "Выполнить?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Да", `admin:confirm:${id}:yes`),
        Markup.button.callback("Нет", `admin:confirm:${id}:no`)
      ]
    ])
  );
}

type ReconcileResult = {
  checked: number;
  fixed: number;
  mismatches: string[];
  unresolved: string[];
};

async function runReconciliation(
  reason: "interval" | "manual" | "daily",
  opts: { notifyOnIssues?: boolean } = {}
): Promise<ReconcileResult> {
  const notifyOnIssues = opts.notifyOnIssues ?? true;
  const orders = repo.getPaidOrdersForReconcile(appConfig.RECONCILE_LIMIT);
  const result: ReconcileResult = {
    checked: 0,
    fixed: 0,
    mismatches: [],
    unresolved: []
  };

  for (const order of orders) {
    result.checked += 1;
    try {
      let remote = order.remnawaveUserUuid ? await rw.getByUuid(order.remnawaveUserUuid) : null;
      if (!remote) {
        remote = await rw.getByTelegramId(order.telegramUserId);
      }

      if (!remote) {
        result.unresolved.push(`#${order.id}: user not found in Remnawave (tg:${order.telegramUserId})`);
        continue;
      }

      const mismatchReasons: string[] = [];
      if (order.remnawaveUserUuid !== remote.uuid) mismatchReasons.push("uuid");
      if (order.remnawaveShortUuid !== remote.shortUuid) mismatchReasons.push("shortUuid");
      if ((order.subscriptionUrl ?? "") !== (remote.subscriptionUrl ?? "")) mismatchReasons.push("subscriptionUrl");
      if ((order.expiresAt ?? "") !== (remote.expireAt ?? "")) mismatchReasons.push("expireAt");

      if (mismatchReasons.length > 0) {
        repo.syncPaidOrderFromRemnawave({
          orderId: order.id,
          remnawaveUserUuid: remote.uuid,
          remnawaveShortUuid: remote.shortUuid,
          subscriptionUrl: remote.subscriptionUrl,
          expiresAt: remote.expireAt
        });
        result.fixed += 1;
        result.mismatches.push(`#${order.id}: fixed [${mismatchReasons.join(", ")}]`);
      }
    } catch (error: any) {
      result.unresolved.push(
        `#${order.id}: reconcile error: ${error?.response?.data ? JSON.stringify(error.response.data) : error?.message ?? "unknown"}`
      );
    }
  }

  const hasIssues = result.mismatches.length > 0 || result.unresolved.length > 0;
  if (hasIssues && notifyOnIssues) {
    const header = `Reconcile report (${reason})\nchecked=${result.checked}, fixed=${result.fixed}, unresolved=${result.unresolved.length}`;
    const mismatchText = result.mismatches.length
      ? `\n\nFixed:\n${result.mismatches.slice(0, 20).join("\n")}`
      : "";
    const unresolvedText = result.unresolved.length
      ? `\n\nUnresolved:\n${result.unresolved.slice(0, 20).join("\n")}`
      : "";
    await notifyAdmins(`${header}${mismatchText}${unresolvedText}`);
  }

  return result;
}

async function sendDailySummary(reportDateLabel: string, dayStartIso: string, dayEndIso: string) {
  const newOrders = repo.getNewOrdersCountBetween(dayStartIso, dayEndIso);
  const paidOrders = repo.getPaidOrdersCountBetween(dayStartIso, dayEndIso);
  const revenueStars = repo.getRevenueStarsBetween(dayStartIso, dayEndIso);
  const trials = repo.getNewTrialsCountBetween(dayStartIso, dayEndIso);
  const activePaid = repo.getActivePaidSubscriptionsCount(new Date().toISOString());
  const stats = repo.stats();
  const topProducts = repo.getTopProductsBetween(dayStartIso, dayEndIso, 5);
  const conversion = newOrders > 0 ? ((paidOrders / newOrders) * 100).toFixed(1) : "0.0";

  const reconcile = await runReconciliation("daily", { notifyOnIssues: false });

  const topProductsBlock = topProducts.length
    ? topProducts.map((p, i) => `${i + 1}) ${p.title} — ${p.count} шт. / ${p.revenue}⭐`).join("\n")
    : "Нет продаж за день";

  const risks: string[] = [];
  if (reconcile.unresolved.length > 0) risks.push(`Есть неустраненные рассинхроны: ${reconcile.unresolved.length}`);
  if (newOrders > 0 && paidOrders === 0) risks.push("Ноль оплат при наличии новых заказов");
  if (trials > 0 && paidOrders === 0) risks.push("Были trial, но нет оплат");
  if (risks.length === 0) risks.push("Критичных аномалий не обнаружено");

  const msg =
    `📊 Ежедневная сводка OBSYDO VPN\n` +
    `🗓 Дата (МСК): ${reportDateLabel}\n` +
    `🕒 Отчет отправлен: ${getMoscowDateTimeLabel()} МСК\n\n` +
    `💰 Коммерция\n` +
    `- Новые заказы: ${newOrders}\n` +
    `- Оплаченные заказы: ${paidOrders}\n` +
    `- Доход: ${revenueStars} ⭐\n` +
    `- Конверсия заказ -> оплата: ${conversion}%\n\n` +
    `👥 Пользователи\n` +
    `- Новых trial: ${trials}\n` +
    `- Активных платных подписок: ${activePaid}\n\n` +
    `🛡 Операционная надежность\n` +
    `- Reconcile проверено: ${reconcile.checked}\n` +
    `- Автоисправлено: ${reconcile.fixed}\n` +
    `- Не устранено: ${reconcile.unresolved.length}\n\n` +
    `🏆 Топ продаж за день\n${topProductsBlock}\n\n` +
    `⚠️ Внимание\n- ${risks.join("\n- ")}\n\n` +
    `📈 Накопительно\n` +
    `- Общий доход: ${stats.totalRevenueStars} ⭐`;

  await notifyAdmins(msg);
}

function mainPanelText() {
  return `Добро пожаловать в ${appConfig.SHOP_NAME}\n\nВыберите нужный раздел:`;
}

function mainPanelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Тарифы", "shop:list"), Markup.button.callback("Мой профиль", "sub:my")],
    [Markup.button.callback("Пробный период", "trial:start"), Markup.button.callback("Помощь", "panel:help")]
  ]);
}

async function renderProfilePanel(ctx: Context) {
  if (!ctx.from) return;
  const latest = repo.getLatestPaidOrderForUser(ctx.from.id);
  const text = latest
    ? `Мой профиль\n\n` +
      `Статус: активен\n` +
      `Действует до: ${toMoscow(latest.expiresAt)} (МСК)\n` +
      `Ссылка подписки:\n${latest.subscriptionUrl ?? "n/a"}`
    : "Мой профиль\n\nУ вас пока нет активной подписки.";
  await upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("Продлить", "shop:list")],
      [Markup.button.callback("Назад", "panel:home")]
    ])
  );
}

async function renderPlansPanel(ctx: Context) {
  const products = repo.getActiveProducts();
  if (!products.length) {
    await upsertPanel(
      ctx,
      "Сейчас нет доступных тарифов.",
      Markup.inlineKeyboard([[Markup.button.callback("Назад", "panel:home")]])
    );
    return;
  }
  const buttons = products.map((p) => [Markup.button.callback(`${p.title} - ${p.starsPrice} ⭐`, `shop:buy:${p.id}`)]);
  buttons.push([Markup.button.callback("Назад", "panel:home")]);
  await upsertPanel(ctx, "Выберите тариф:", Markup.inlineKeyboard(buttons));
}

async function renderHelpPanel(ctx: Context) {
  await upsertPanel(
    ctx,
    "Помощь\n\nЕсли возникли вопросы по оплате или подключению, напишите в поддержку.",
    Markup.inlineKeyboard([
      [Markup.button.url("Поддержка", appConfig.SUPPORT_LINK)],
      [Markup.button.callback("Назад", "panel:home")]
    ])
  );
}

async function upsertPanel(ctx: Context, text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard>) {
  const chatId = ctx.chat?.id;
  const tgUserId = ctx.from?.id;
  if (!chatId || !tgUserId) return;

  const hasCallback = "callbackQuery" in ctx.update;
  if (hasCallback) {
    const cbMsg = ctx.callbackQuery?.message;
    const cbMsgId = cbMsg && "message_id" in cbMsg ? cbMsg.message_id : null;
    if (typeof cbMsgId === "number") {
      await ctx.editMessageText(text, keyboard);
      repo.setPanelMessageId(tgUserId, cbMsgId);
      return;
    }
  }

  const panelId = repo.getPanelMessageId(tgUserId);
  if (panelId) {
    try {
      await bot.telegram.editMessageText(chatId, panelId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
      return;
    } catch {
      // fall through and create new panel
    }
  }

  const sent = await ctx.reply(text, keyboard);
  repo.setPanelMessageId(tgUserId, sent.message_id);
}

bot.start(async (ctx) => {
  await upsertPanel(ctx, mainPanelText(), mainPanelKeyboard());
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Команды:\n" +
      "/start - главное меню\n" +
      "/plans - список тарифов\n" +
      "/trial - пробный период (1 раз)\n" +
      "/mysub - моя подписка\n" +
      "/admin - админка (только админ)\n" +
      "/stats, /orders, /finduser, /grantdays, /revoke, /broadcast - админ-команды"
  );
});

bot.command("plans", async (ctx) => {
  await renderPlansPanel(ctx);
});

bot.command("trial", async (ctx) => {
  if (!ctx.from) return;
  if (repo.hasUsedTrial(ctx.from.id)) {
    await transientReply(ctx, "Пробный период уже был активирован ранее.");
    return;
  }
  const latest = repo.getLatestPaidOrderForUser(ctx.from.id);
  if (latest) {
    await transientReply(ctx, "У вас уже есть покупка в системе, пробный период недоступен.");
    return;
  }
  try {
    const rwUser = await rw.createTrial({
      telegramId: ctx.from.id,
      username: makeUsername(ctx),
      trialHours: appConfig.TRIAL_DURATION_HOURS
    });
    repo.saveTrial({
      telegramUserId: ctx.from.id,
      remnawaveUserUuid: rwUser.uuid,
      expiresAt: rwUser.expireAt
    });
    await upsertPanel(
      ctx,
      `Пробный период активирован: ${appConfig.TRIAL_DURATION_HOURS} час, ${appConfig.TRIAL_TRAFFIC_GB} GB.\n` +
        `Доступ до: ${toMoscow(rwUser.expireAt)} (МСК)\n` +
        `Ссылка подписки:\n${rwUser.subscriptionUrl}`,
      Markup.inlineKeyboard([[Markup.button.callback("Главное меню", "panel:home")]])
    );
  } catch (error: any) {
    await transientReply(ctx, "Не удалось активировать пробный период. Напишите в поддержку.");
    console.error("Trial failed:", error?.response?.data ?? error?.message ?? error);
  }
});

bot.command("mysub", async (ctx) => {
  await renderProfilePanel(ctx);
});

bot.action("sub:my", async (ctx) => {
  await ctx.answerCbQuery();
  await renderProfilePanel(ctx);
});

bot.action("panel:help", async (ctx) => {
  await ctx.answerCbQuery();
  await renderHelpPanel(ctx);
});

bot.action("panel:home", async (ctx) => {
  await ctx.answerCbQuery();
  await upsertPanel(ctx, mainPanelText(), mainPanelKeyboard());
});

bot.action("shop:list", async (ctx) => {
  await ctx.answerCbQuery();
  await renderPlansPanel(ctx);
});

bot.action("trial:start", async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.from) return;
  if (repo.hasUsedTrial(ctx.from.id)) {
    await transientReply(ctx, "Пробный период уже был активирован ранее.");
    return;
  }
  const latest = repo.getLatestPaidOrderForUser(ctx.from.id);
  if (latest) {
    await transientReply(ctx, "У вас уже есть покупка в системе, пробный период недоступен.");
    return;
  }
  try {
    const rwUser = await rw.createTrial({
      telegramId: ctx.from.id,
      username: makeUsername(ctx),
      trialHours: appConfig.TRIAL_DURATION_HOURS
    });
    repo.saveTrial({
      telegramUserId: ctx.from.id,
      remnawaveUserUuid: rwUser.uuid,
      expiresAt: rwUser.expireAt
    });
    await upsertPanel(
      ctx,
      `Пробный период активирован: ${appConfig.TRIAL_DURATION_HOURS} час, ${appConfig.TRIAL_TRAFFIC_GB} GB.\n` +
        `Доступ до: ${toMoscow(rwUser.expireAt)} (МСК)\n` +
        `Ссылка подписки:\n${rwUser.subscriptionUrl}`,
      Markup.inlineKeyboard([[Markup.button.callback("Главное меню", "panel:home")]])
    );
  } catch (error: any) {
    await transientReply(ctx, "Не удалось активировать пробный период. Напишите в поддержку.");
    console.error("Trial failed:", error?.response?.data ?? error?.message ?? error);
  }
});

bot.action(/^shop:buy:(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const productId = Number(ctx.match[1]);
  const product = repo.getProductById(productId);
  if (!product || !product.isActive) {
    await ctx.answerCbQuery("Тариф не найден");
    return;
  }
  const payload = `order:${ctx.from.id}:${Date.now()}:${product.id}`;
  repo.createPendingOrder({
    telegramUserId: ctx.from.id,
    telegramUsername: ctx.from.username ?? null,
    productId: product.id,
    amountStars: product.starsPrice,
    payload
  });
  const invoiceMessage = await ctx.replyWithInvoice({
    title: `${appConfig.SHOP_NAME} - ${product.title}`,
    description: `${product.description}\nСрок: ${product.durationDays} дней\nТрафик: ${formatTraffic(product.trafficLimitGb)}`,
    payload,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: product.title, amount: product.starsPrice }]
  });
  repo.setInvoiceMeta({
    payload,
    invoiceChatId: ctx.chat!.id,
    invoiceMessageId: invoiceMessage.message_id,
    invoiceExpiresAt: new Date(Date.now() + INVOICE_TTL_MINUTES * 60 * 1000).toISOString()
  });
  await ctx.answerCbQuery();
  await upsertPanel(
    ctx,
    `Счет выставлен на ${INVOICE_TTL_MINUTES} минут.\nПосле оплаты доступ активируется автоматически.`,
    Markup.inlineKeyboard([[Markup.button.callback("Назад", "panel:home")]])
  );
});

bot.on("pre_checkout_query", async (ctx) => {
  const payload = ctx.preCheckoutQuery.invoice_payload;
  const order = repo.getOrderByPayload(payload);
  if (!order) {
    await notifyAdmins(`pre_checkout: order not found, payload=${payload}, from=${ctx.from?.id ?? "unknown"}`);
    await ctx.answerPreCheckoutQuery(false, "Заказ не найден");
    return;
  }
  if (order.status !== "PENDING") {
    await notifyAdmins(`pre_checkout: invalid status=${order.status}, payload=${payload}, from=${ctx.from?.id ?? "unknown"}`);
    await ctx.answerPreCheckoutQuery(false, "Заказ уже обработан");
    return;
  }
  if (order.invoiceExpiresAt && new Date(order.invoiceExpiresAt).getTime() < Date.now()) {
    repo.deletePendingOrderById(order.id);
    if (order.invoiceChatId && order.invoiceMessageId) {
      await safeDelete(order.invoiceChatId, order.invoiceMessageId);
    }
    await ctx.answerPreCheckoutQuery(false, "Счет истек. Создайте новый.");
    return;
  }
  if (ctx.preCheckoutQuery.currency !== "XTR") {
    await notifyAdmins(`pre_checkout: invalid currency=${ctx.preCheckoutQuery.currency}, payload=${payload}`);
    await ctx.answerPreCheckoutQuery(false, "Неверная валюта оплаты");
    return;
  }
  if (ctx.preCheckoutQuery.total_amount !== order.amountStars) {
    await notifyAdmins(
      `pre_checkout: amount mismatch payload=${payload}, expected=${order.amountStars}, got=${ctx.preCheckoutQuery.total_amount}`
    );
    await ctx.answerPreCheckoutQuery(false, "Некорректная сумма");
    return;
  }
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("message", async (ctx, next) => {
  const msg: any = ctx.message;
  if (!msg?.successful_payment || !ctx.from) return next();
  const payment = msg.successful_payment;

  const order = repo.getOrderByPayload(payment.invoice_payload);
  if (!order) {
    await notifyAdmins(
      `successful_payment without order. payload=${payment.invoice_payload}, charge=${payment.telegram_payment_charge_id}, tg=${ctx.from.id}`
    );
    await transientReply(ctx, "Платеж получен, но заказ не найден. Напишите в поддержку.");
    return;
  }

  const chargeOrder = repo.getOrderByPaymentChargeId(payment.telegram_payment_charge_id);
  if (chargeOrder && chargeOrder.payload !== order.payload) {
    await notifyAdmins(
      `charge reused. charge=${payment.telegram_payment_charge_id}, orderA=${chargeOrder.id}, orderB=${order.id}`
    );
    await transientReply(ctx, "Платеж обрабатывается. Если доступ не пришел, напишите в поддержку.");
    return;
  }

  if (order.status === "PAID") {
    await transientReply(ctx, "Платеж уже обработан ранее.");
    return;
  }

  const product = repo.getProductById(order.productId);
  if (!product) {
    repo.markOrderFailed(order.payload);
    await notifyAdmins(`product missing for paid order payload=${order.payload}, orderId=${order.id}`);
    await transientReply(ctx, "Платеж получен, но тариф не найден. Напишите в поддержку.");
    return;
  }

  try {
    const trafficBytes = product.trafficLimitGb === 0 ? 0 : product.trafficLimitGb * 1024 * 1024 * 1024;
    let rwUser: Awaited<ReturnType<typeof rw.provisionOrExtend>> | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        rwUser = await rw.provisionOrExtend({
          telegramId: ctx.from.id,
          username: makeUsername(ctx),
          durationDays: product.durationDays,
          trafficLimitBytes: trafficBytes
        });
        break;
      } catch (e) {
        lastError = e;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }

    if (!rwUser) throw lastError ?? new Error("Provision failed after retries");

    const paidOrder = repo.markOrderPaid({
      payload: order.payload,
      paymentChargeId: payment.telegram_payment_charge_id,
      remnawaveUserUuid: rwUser.uuid,
      remnawaveShortUuid: rwUser.shortUuid,
      subscriptionUrl: rwUser.subscriptionUrl,
      expiresAt: rwUser.expireAt
    });
    if (!paidOrder) {
      await transientReply(ctx, "Платеж уже был обработан ранее.");
      return;
    }

    await upsertPanel(
      ctx,
      "Оплата прошла успешно.\n\n" +
        `Тариф: ${product.title}\n` +
        `Действует до: ${toMoscow(rwUser.expireAt)} (МСК)\n` +
        `Ссылка подписки:\n${rwUser.subscriptionUrl}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Мой профиль", "sub:my")],
        [Markup.button.callback("Главное меню", "panel:home")]
      ])
    );
  } catch (error: any) {
    repo.markOrderFailed(order.payload);
    await notifyAdmins(
      `provision failed for order=${order.id}, payload=${order.payload}, tg=${ctx.from.id}, err=${
        error?.response?.data ? JSON.stringify(error.response.data) : error?.message ?? "unknown"
      }`
    );
    await transientReply(ctx, "Оплата прошла, но выдача доступа не удалась. Админ уже получил уведомление.");
    console.error("Provisioning failed:", error?.response?.data ?? error?.message ?? error);
  }
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) {
    await transientReply(ctx, "Недостаточно прав.");
    return;
  }
  const stats = repo.stats();
  await ctx.reply(
    "Админ-панель:\n" +
      `- Тарифов: ${stats.products}\n` +
      `- Оплачено: ${stats.paid}\n` +
      `- Ожидают: ${stats.pending}\n` +
      `- Выручка: ${stats.totalRevenueStars} ⭐`,
    adminPanelKeyboard()
  );
});

bot.action("admin:stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const s = repo.stats();
  await ctx.reply(
    `Статистика:\n- Оплачено: ${s.paid}\n- В ожидании: ${s.pending}\n- Выручка: ${s.totalRevenueStars}⭐\n- Тарифов: ${s.products}`,
    adminPanelKeyboard()
  );
});

bot.action("admin:help", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(adminCommandsHelpText());
});

bot.action("admin:search-help", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply("Поиск пользователя:\nИспользуйте команду /finduser <telegramId>\nПример: /finduser 238163596");
});

bot.action("admin:user:lookup", async (ctx) => {
  if (!isAdmin(ctx) || !ctx.from) return;
  await ctx.answerCbQuery();
  setAdminInput(ctx.from.id, "FIND_USER");
  await ctx.reply("Введите telegramId пользователя одним сообщением.");
});

bot.action("admin:broadcast:prompt", async (ctx) => {
  if (!isAdmin(ctx) || !ctx.from) return;
  await ctx.answerCbQuery();
  setAdminInput(ctx.from.id, "BROADCAST");
  await ctx.reply("Введите текст рассылки одним сообщением. Отправка пойдет всем платным пользователям.");
});

bot.action("admin:products", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const products = repo.getAllProducts();
  const buttons = products.map((p) => [Markup.button.callback(`${p.isActive ? "ON" : "OFF"} ${p.title}`, `admin:product:${p.id}`)]);
  buttons.push([Markup.button.callback("Назад", "admin:home")]);
  await ctx.editMessageText(
    "Управление тарифами:\nВыберите тариф кнопкой ниже для inline-редактирования.",
    Markup.inlineKeyboard(buttons)
  );
  await ctx.answerCbQuery();
});

bot.action("admin:orders", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const orders = repo.recentOrders(10);
  const text =
    "Последние 10 заказов:\n\n" +
    (orders.length
      ? orders
          .map((o) => `#${o.id} | ${o.status} | ${o.amountStars}⭐ | user:${o.telegramUserId} | expires:${toMoscow(o.expiresAt)}`)
          .join("\n")
      : "Нет заказов");
  await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback("Назад", "admin:products")]]));
  await ctx.answerCbQuery();
});

bot.action("admin:home", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const stats = repo.stats();
  await ctx.reply(
    "Админ-панель:\n" +
      `- Тарифов: ${stats.products}\n` +
      `- Оплачено: ${stats.paid}\n` +
      `- Ожидают: ${stats.pending}\n` +
      `- Выручка: ${stats.totalRevenueStars} ⭐`,
    adminPanelKeyboard()
  );
});

bot.action(/^admin:product:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = Number(ctx.match[1]);
  const p = repo.getProductById(id);
  if (!p) {
    await ctx.answerCbQuery("Тариф не найден");
    return;
  }
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `Тариф: ${p.title}\n` +
      `code: ${p.code}\n` +
      `Цена: ${p.starsPrice}⭐\n` +
      `Срок: ${p.durationDays} дней\n` +
      `Трафик: ${p.trafficLimitGb}GB\n` +
      `Статус: ${p.isActive ? "ON" : "OFF"}\n\n` +
      "Редактирование inline:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Цена -10", `admin:plan:${id}:price:-10`), Markup.button.callback("Цена +10", `admin:plan:${id}:price:10`)],
      [Markup.button.callback("Дни -1", `admin:plan:${id}:days:-1`), Markup.button.callback("Дни +1", `admin:plan:${id}:days:1`)],
      [
        Markup.button.callback("Трафик -50GB", `admin:plan:${id}:traffic:-50`),
        Markup.button.callback("Трафик +50GB", `admin:plan:${id}:traffic:50`)
      ],
      [Markup.button.callback("ON/OFF", `admin:plan:${id}:toggle:0`)],
      [Markup.button.callback("К списку тарифов", "admin:products")]
    ])
  );
});

bot.action(/^admin:plan:(\d+):(price|days|traffic|toggle):(-?\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = Number(ctx.match[1]);
  const mode = ctx.match[2];
  const delta = Number(ctx.match[3]);
  const current = repo.getProductById(id);
  if (!current) {
    await ctx.answerCbQuery("Тариф не найден");
    return;
  }
  if (mode === "toggle") {
    repo.toggleProduct(id);
  } else if (mode === "price") {
    const next = Math.max(1, current.starsPrice + delta);
    repo.updateProductByCode({ code: current.code, starsPrice: next });
  } else if (mode === "days") {
    const next = Math.max(1, current.durationDays + delta);
    repo.updateProductByCode({ code: current.code, durationDays: next });
  } else if (mode === "traffic") {
    const next = Math.max(0, current.trafficLimitGb + delta);
    repo.updateProductByCode({ code: current.code, trafficLimitGb: next });
  }
  await ctx.answerCbQuery("Обновлено");
  const updated = repo.getProductById(id);
  if (!updated) return;
  await ctx.editMessageText(
    `Тариф: ${updated.title}\n` +
      `code: ${updated.code}\n` +
      `Цена: ${updated.starsPrice}⭐\n` +
      `Срок: ${updated.durationDays} дней\n` +
      `Трафик: ${updated.trafficLimitGb}GB\n` +
      `Статус: ${updated.isActive ? "ON" : "OFF"}\n\n` +
      "Редактирование inline:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Цена -10", `admin:plan:${id}:price:-10`), Markup.button.callback("Цена +10", `admin:plan:${id}:price:10`)],
      [Markup.button.callback("Дни -1", `admin:plan:${id}:days:-1`), Markup.button.callback("Дни +1", `admin:plan:${id}:days:1`)],
      [
        Markup.button.callback("Трафик -50GB", `admin:plan:${id}:traffic:-50`),
        Markup.button.callback("Трафик +50GB", `admin:plan:${id}:traffic:50`)
      ],
      [Markup.button.callback("ON/OFF", `admin:plan:${id}:toggle:0`)],
      [Markup.button.callback("К списку тарифов", "admin:products")]
    ])
  );
});

bot.command("addplan", async (ctx) => {
  if (!isAdmin(ctx)) {
    await transientReply(ctx, "Недостаточно прав.");
    return;
  }
  const parts = ctx.message.text.split(" ").slice(1).join(" ").split("|").map((v) => v.trim());
  if (parts.length !== 6) {
    await ctx.reply("Формат: /addplan code|title|description|stars|days|trafficGb");
    return;
  }
  const [code, title, description, starsStr, daysStr, trafficStr] = parts;
  const stars = Number(starsStr);
  const days = Number(daysStr);
  const traffic = Number(trafficStr);
  if (!Number.isFinite(stars) || !Number.isFinite(days) || !Number.isFinite(traffic)) {
    await ctx.reply("stars, days и trafficGb должны быть числами.");
    return;
  }
  if (repo.getProductByCode(code)) {
    await ctx.reply("Товар с таким code уже существует.");
    return;
  }
  const product = repo.createProduct({
    code,
    title,
    description,
    starsPrice: stars,
    durationDays: days,
    trafficLimitGb: traffic
  });
  await ctx.reply(`Тариф создан: ${product.title} (${product.starsPrice}⭐)`);
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const s = repo.stats();
  await ctx.reply(
    `Статистика:\n- Оплачено: ${s.paid}\n- В ожидании: ${s.pending}\n- Выручка: ${s.totalRevenueStars}⭐\n- Тарифов: ${s.products}`
  );
});

bot.command("plansadmin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const products = repo.getAllProducts();
  if (!products.length) {
    await ctx.reply("Тарифов нет.");
    return;
  }
  const text = products
    .map(
      (p) =>
        `${p.isActive ? "ON" : "OFF"} ${p.code}\n` +
        `- ${p.title}\n` +
        `- ${p.starsPrice}⭐ / ${p.durationDays} дней / ${p.trafficLimitGb}GB`
    )
    .join("\n\n");
  await ctx.reply(text);
});

bot.command("setprice", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, codeRaw, starsRaw] = ctx.message.text.split(" ");
  const code = (codeRaw ?? "").trim();
  const stars = Number(starsRaw);
  if (!code || !Number.isFinite(stars) || stars <= 0) {
    await ctx.reply("Формат: /setprice <code> <stars>");
    return;
  }
  const updated = repo.updateProductByCode({ code, starsPrice: stars });
  if (!updated) {
    await ctx.reply("Тариф с таким code не найден.");
    return;
  }
  await ctx.reply(`Цена обновлена: ${updated.code} -> ${updated.starsPrice}⭐`);
});

bot.command("editplan", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const payload = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const parts = payload.split("|").map((v) => v.trim());
  if (parts.length !== 6) {
    await ctx.reply("Формат: /editplan <code>|<title>|<description>|<stars>|<days>|<trafficGb>");
    return;
  }
  const [code, title, description, starsStr, daysStr, trafficStr] = parts;
  const stars = Number(starsStr);
  const days = Number(daysStr);
  const traffic = Number(trafficStr);
  if (!code || !title || !description || !Number.isFinite(stars) || !Number.isFinite(days) || !Number.isFinite(traffic)) {
    await ctx.reply("Проверьте поля: code/title/description обязательны, stars/days/trafficGb должны быть числами.");
    return;
  }
  if (stars <= 0 || days <= 0 || traffic < 0) {
    await ctx.reply("Ограничения: stars > 0, days > 0, trafficGb >= 0.");
    return;
  }
  const updated = repo.updateProductByCode({
    code,
    title,
    description,
    starsPrice: stars,
    durationDays: days,
    trafficLimitGb: traffic
  });
  if (!updated) {
    await ctx.reply("Тариф с таким code не найден.");
    return;
  }
  await ctx.reply(
    `Тариф обновлен:\n` +
      `- code: ${updated.code}\n` +
      `- title: ${updated.title}\n` +
      `- price: ${updated.starsPrice}⭐\n` +
      `- duration: ${updated.durationDays} дней\n` +
      `- traffic: ${updated.trafficLimitGb}GB`
  );
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const n = Number(ctx.message.text.split(" ")[1] ?? "10");
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 10;
  const orders = repo.recentOrders(limit);
  const text = orders.length
    ? orders
        .map((o) => `#${o.id} ${o.status} ${o.amountStars}⭐ user:${o.telegramUserId} exp:${toMoscow(o.expiresAt)}`)
        .join("\n")
    : "Нет заказов";
  await ctx.reply(text);
});

bot.command("finduser", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /finduser <telegramId>");
    return;
  }
  const latest = repo.getLatestPaidOrderForUser(tgId);
  const rwUser = await rw.getByTelegramId(tgId);
  await ctx.reply(
    `Пользователь ${tgId}\n` +
      `- RW UUID: ${rwUser?.uuid ?? "-"}\n` +
      `- До: ${toMoscow(rwUser?.expireAt ?? latest?.expiresAt ?? null)}\n` +
      `- Последний заказ: ${latest ? `#${latest.id} ${latest.status} ${latest.amountStars}⭐` : "нет"}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Enable", `admin:user:${tgId}:ENABLE`),
        Markup.button.callback("Disable", `admin:user:${tgId}:DISABLE`)
      ],
      [
        Markup.button.callback("Reset", `admin:user:${tgId}:RESET`),
        Markup.button.callback("Revoke", `admin:user:${tgId}:REVOKE`)
      ],
      [Markup.button.callback("Delete", `admin:user:${tgId}:DELETE`)],
      [Markup.button.callback("+30 дней", `admin:user:${tgId}:GRANT30`)],
      [Markup.button.callback("Админка", "admin:home")]
    ])
  );
});

bot.on("text", async (ctx, next) => {
  if (!ctx.from || !isAdmin(ctx)) return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  const state = getAdminInput(ctx.from.id);
  if (!state) return next();

  if (state.mode === "FIND_USER") {
    clearAdminInput(ctx.from.id);
    const tgId = Number(text);
    if (!Number.isFinite(tgId)) {
      await ctx.reply("Нужен telegramId числом.");
      return;
    }
    const latest = repo.getLatestPaidOrderForUser(tgId);
    const rwUser = await rw.getByTelegramId(tgId);
    await ctx.reply(
      `Пользователь ${tgId}\n` +
        `- RW UUID: ${rwUser?.uuid ?? "-"}\n` +
        `- До: ${toMoscow(rwUser?.expireAt ?? latest?.expiresAt ?? null)}\n` +
        `- Последний заказ: ${latest ? `#${latest.id} ${latest.status} ${latest.amountStars}⭐` : "нет"}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Enable", `admin:user:${tgId}:ENABLE`),
          Markup.button.callback("Disable", `admin:user:${tgId}:DISABLE`)
        ],
        [
          Markup.button.callback("Reset", `admin:user:${tgId}:RESET`),
          Markup.button.callback("Revoke", `admin:user:${tgId}:REVOKE`)
        ],
        [Markup.button.callback("Delete", `admin:user:${tgId}:DELETE`)],
        [Markup.button.callback("+30 дней", `admin:user:${tgId}:GRANT30`)],
        [Markup.button.callback("Админка", "admin:home")]
      ])
    );
    return;
  }

  if (state.mode === "BROADCAST") {
    clearAdminInput(ctx.from.id);
    const ids = repo.getPaidUserIds();
    let sent = 0;
    for (const id of ids) {
      try {
        await bot.telegram.sendMessage(id, text);
        sent += 1;
      } catch {
        // Continue sending to other users.
      }
    }
    await ctx.reply(`Рассылка завершена: ${sent}/${ids.length}`);
    return;
  }
  return next();
});

bot.command("grantdays", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [_, tgIdStr, daysStr] = ctx.message.text.split(" ");
  const tgId = Number(tgIdStr);
  const days = Number(daysStr);
  if (!Number.isFinite(tgId) || !Number.isFinite(days) || days <= 0) {
    await ctx.reply("Формат: /grantdays <telegramId> <days>");
    return;
  }
  const rwUser = await rw.getByTelegramId(tgId);
  if (!rwUser) {
    await ctx.reply("Пользователь не найден в Remnawave.");
    return;
  }
  const updated = await rw.extendExistingUser(rwUser, days, appConfig.defaultTrafficBytes);
  await ctx.reply(`Продлено на ${days} дн. Новый срок: ${toMoscow(updated.expireAt)} (МСК)`);
});

bot.command("enable", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /enable <telegramId>");
    return;
  }
  await requestDangerActionConfirm(ctx, "ENABLE", tgId);
});

bot.command("disable", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /disable <telegramId>");
    return;
  }
  await requestDangerActionConfirm(ctx, "DISABLE", tgId);
});

bot.command("reset", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /reset <telegramId>");
    return;
  }
  await requestDangerActionConfirm(ctx, "RESET", tgId);
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /revoke <telegramId>");
    return;
  }
  await requestDangerActionConfirm(ctx, "REVOKE", tgId);
});

bot.command("delete", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tgId = Number(ctx.message.text.split(" ")[1]);
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Формат: /delete <telegramId>");
    return;
  }
  await requestDangerActionConfirm(ctx, "DELETE", tgId);
});

bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) {
    await ctx.reply("Формат: /broadcast <текст>");
    return;
  }
  const ids = repo.getPaidUserIds();
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, text);
      sent += 1;
    } catch {
      // Continue sending to other users.
    }
  }
  await ctx.reply(`Рассылка завершена: ${sent}/${ids.length}`);
});

bot.command("reconcile", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply("Запускаю сверку с Remnawave...");
  const result = await runReconciliation("manual");
  await ctx.reply(
    `Готово.\n` +
      `- Проверено: ${result.checked}\n` +
      `- Исправлено: ${result.fixed}\n` +
      `- Не решено: ${result.unresolved.length}`
  );
});

bot.command("dailyreport", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { startIso, endIso, label } = getUtcRangeForMoscowDay(-1);
  await ctx.reply(`Формирую ежедневную сводку за ${label} (МСК)...`);
  await sendDailySummary(label, startIso, endIso);
  await ctx.reply("Сводка отправлена.");
});

bot.action(/^admin:user:(\d+):(ENABLE|DISABLE|RESET|REVOKE|DELETE|GRANT30)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const tgId = Number(ctx.match[1]);
  const action = ctx.match[2];
  if (!Number.isFinite(tgId)) {
    await ctx.reply("Некорректный telegramId.");
    return;
  }
  if (action === "GRANT30") {
    const rwUser = await rw.getByTelegramId(tgId);
    if (!rwUser) {
      await ctx.reply("Пользователь не найден в Remnawave.");
      return;
    }
    const updated = await rw.extendExistingUser(rwUser, 30, appConfig.defaultTrafficBytes);
    await ctx.reply(`Продлено на 30 дней. Новый срок: ${toMoscow(updated.expireAt)} (МСК)`);
    return;
  }
  await requestDangerActionConfirm(ctx, action as AdminDangerAction, tgId);
});

bot.action(/^admin:confirm:([a-z0-9]+):(yes|no)$/, async (ctx) => {
  if (!isAdmin(ctx) || !ctx.from) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const answer = ctx.match[2];
  const pending = pendingAdminActions.get(id);
  if (!pending) {
    await ctx.reply("Подтверждение устарело или уже обработано.");
    return;
  }
  if (pending.adminId !== ctx.from.id) {
    await ctx.reply("Это подтверждение создано другим админом.");
    return;
  }
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingAdminActions.delete(id);
    await ctx.reply("Подтверждение истекло (10 минут).");
    return;
  }
  if (answer === "no") {
    pendingAdminActions.delete(id);
    await ctx.reply("Действие отменено.");
    return;
  }

  try {
    if (pending.action === "ENABLE") {
      await rw.enableUser(pending.targetUuid);
    } else if (pending.action === "DISABLE") {
      await rw.disableUser(pending.targetUuid);
    } else if (pending.action === "RESET") {
      await rw.resetTraffic(pending.targetUuid);
    } else if (pending.action === "REVOKE") {
      await rw.revokeSubscription(pending.targetUuid);
    } else if (pending.action === "DELETE") {
      await rw.deleteUser(pending.targetUuid);
    }
    await ctx.reply(`Выполнено: ${pending.action} для telegramId ${pending.targetTelegramId}.`);
  } catch (error: any) {
    await ctx.reply(
      `Ошибка выполнения ${pending.action}: ${
        error?.response?.data ? JSON.stringify(error.response.data) : error?.message ?? "unknown"
      }`
    );
  } finally {
    pendingAdminActions.delete(id);
  }
});

export async function launchBot() {
  await bot.launch();
  startPendingInvoiceCleanupLoop();
  startExpiryReminderLoop();
  startReconciliationLoop();
  startDailySummaryLoop();
  console.log("Bot launched");
}

function startPendingInvoiceCleanupLoop() {
  const cleanup = async () => {
    const expired = repo.getExpiredPendingOrders(new Date().toISOString());
    for (const order of expired) {
      if (order.invoiceChatId && order.invoiceMessageId) {
        await safeDelete(order.invoiceChatId, order.invoiceMessageId);
      }
      repo.deletePendingOrderById(order.id);
    }
  };

  void cleanup();
  setInterval(() => {
    void cleanup();
  }, 60 * 1000);
}

function startExpiryReminderLoop() {
  const check = async () => {
    const now = Date.now();
    const orders = repo.getPaidOrdersForReminders();
    for (const order of orders) {
      if (!order.expiresAt) continue;
      const expiresAtMs = new Date(order.expiresAt).getTime();
      if (Number.isNaN(expiresAtMs)) continue;
      const diff = expiresAtMs - now;

      if (diff <= 24 * 60 * 60 * 1000 && diff > 23 * 60 * 60 * 1000 && !repo.hasReminder(order.id, "H24")) {
        try {
          await bot.telegram.sendMessage(
            order.telegramUserId,
            `Напоминание: подписка OBSYDO VPN закончится через 24 часа.\n` +
              `Окончание: ${toMoscow(order.expiresAt)} (МСК)\n` +
              "Продлить можно через кнопку «Купить VPN»."
          );
          repo.markReminderSent(order.id, "H24");
        } catch (e) {
          console.error("24h reminder failed", e);
          await notifyAdmins(`Не удалось отправить reminder H24 для order=${order.id}, user=${order.telegramUserId}`);
        }
      }

      if (diff <= 60 * 60 * 1000 && diff > 50 * 60 * 1000 && !repo.hasReminder(order.id, "H1")) {
        try {
          await bot.telegram.sendMessage(
            order.telegramUserId,
            `Напоминание: подписка OBSYDO VPN закончится примерно через 1 час.\n` +
              `Окончание: ${toMoscow(order.expiresAt)} (МСК)\n` +
              "Продлить можно через кнопку «Купить VPN»."
          );
          repo.markReminderSent(order.id, "H1");
        } catch (e) {
          console.error("1h reminder failed", e);
          await notifyAdmins(`Не удалось отправить reminder H1 для order=${order.id}, user=${order.telegramUserId}`);
        }
      }
    }
  };

  void check();
  setInterval(() => {
    void check();
  }, 10 * 60 * 1000);
}

function startReconciliationLoop() {
  const intervalMs = appConfig.RECONCILE_INTERVAL_MINUTES * 60 * 1000;
  void runReconciliation("interval");
  setInterval(() => {
    void runReconciliation("interval");
  }, intervalMs);
}

function startDailySummaryLoop() {
  const sendIfNeeded = async () => {
    const yesterday = getUtcRangeForMoscowDay(-1);
    if (repo.hasDailyReport(yesterday.label)) return;
    await sendDailySummary(yesterday.label, yesterday.startIso, yesterday.endIso);
    repo.markDailyReportSent(yesterday.label);
  };

  const check = async () => {
    const now = new Date();
    const moscowTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: appConfig.TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(now);

    // Отправляем отчет ежедневно в 23:00 МСК, за прошедший календарный день.
    if (moscowTime !== "23:00") return;
    try {
      await sendIfNeeded();
    } catch (error) {
      await notifyAdmins(`daily summary failed: ${String(error)}`);
    }
  };

  // Catch-up on startup in case bot was down at 23:00.
  void sendIfNeeded().catch((error) => {
    void notifyAdmins(`daily summary catch-up failed: ${String(error)}`);
  });

  void check();
  setInterval(() => {
    void check();
  }, 60 * 1000);
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
