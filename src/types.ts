export type Product = {
  id: number;
  code: string;
  title: string;
  description: string;
  starsPrice: number;
  durationDays: number;
  trafficLimitGb: number;
  isActive: number;
};

export type OrderStatus = "PENDING" | "PAID" | "FAILED";

export type Order = {
  id: number;
  telegramUserId: number;
  telegramUsername: string | null;
  productId: number;
  amountStars: number;
  payload: string;
  status: OrderStatus;
  remnawaveUserUuid: string | null;
  remnawaveShortUuid: string | null;
  subscriptionUrl: string | null;
  expiresAt: string | null;
  paymentChargeId: string | null;
  invoiceChatId: number | null;
  invoiceMessageId: number | null;
  invoiceExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReminderType = "H24" | "H1";

export type Trial = {
  telegramUserId: number;
  remnawaveUserUuid: string;
  expiresAt: string;
  createdAt: string;
};

export type RemnawaveUser = {
  uuid: string;
  shortUuid: string;
  username: string;
  expireAt: string;
  subscriptionUrl: string;
  trafficLimitBytes: number;
};
