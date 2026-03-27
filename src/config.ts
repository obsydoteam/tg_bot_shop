import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const schema = z.object({
  BOT_TOKEN: z.string().min(1),
  REMNAWAVE_BASE_URL: z.string().url(),
  REMNAWAVE_USERNAME: z.string().min(1),
  REMNAWAVE_PASSWORD: z.string().min(1),
  REMNAWAVE_API_TOKEN: z.string().optional(),
  ADMIN_TELEGRAM_IDS: z.string().default(""),
  SHOP_NAME: z.string().default("OBSYDO VPN"),
  SUPPORT_LINK: z.string().default("https://t.me/obsydo"),
  DATABASE_PATH: z.string().default("/app/data/shop.db"),
  DEFAULT_TRAFFIC_GB: z.coerce.number().int().positive().default(300),
  DEFAULT_HARDWARE_LIMIT: z.coerce.number().int().min(0).default(5),
  DEFAULT_PLAN_PRICE_STARS: z.coerce.number().int().positive().default(200),
  DEFAULT_PLAN_DURATION_DAYS: z.coerce.number().int().positive().default(30),
  TRIAL_DURATION_HOURS: z.coerce.number().int().positive().default(1),
  TIMEZONE: z.string().default("Europe/Moscow"),
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  RECONCILE_LIMIT: z.coerce.number().int().positive().default(2000),
  DB_BACKUP_DIR: z.string().default("/app/data/backups"),
  DB_BACKUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  DB_BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(14)
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid env: ${parsed.error.message}`);
}

const data = parsed.data;

export const appConfig = {
  ...data,
  adminIds: data.ADMIN_TELEGRAM_IDS.split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v)),
  defaultTrafficBytes: data.DEFAULT_TRAFFIC_GB * 1024 * 1024 * 1024
};
