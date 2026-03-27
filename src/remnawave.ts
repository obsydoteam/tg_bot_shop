import axios, { type AxiosInstance } from "axios";
import { appConfig } from "./config.js";
import type { RemnawaveUser } from "./types.js";

type RemnawaveListResp<T> = { response: T[] };
type RemnawaveObjResp<T> = { response: T };

type ApiUser = {
  uuid: string;
  shortUuid: string;
  username: string;
  tag?: string | null;
  expireAt: string;
  subscriptionUrl: string;
  trafficLimitBytes: number;
};

type ApiActionResponse = {
  response?: {
    success?: boolean;
    message?: string;
  };
};

type ApiInternalSquad = {
  uuid: string;
  name?: string;
  title?: string;
  tag?: string;
};

export class RemnawaveClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private readonly staticApiToken: string | null;
  private publicSquadUuid: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: appConfig.REMNAWAVE_BASE_URL.replace(/\/+$/, ""),
      timeout: 15000
    });
    this.staticApiToken = appConfig.REMNAWAVE_API_TOKEN?.trim() || null;
  }

  private async ensureAuth() {
    if (this.staticApiToken) {
      this.token = this.staticApiToken;
      return;
    }
    if (this.token) return;
    const { data } = await this.client.post<RemnawaveObjResp<{ accessToken: string }>>("/api/auth/login", {
      username: appConfig.REMNAWAVE_USERNAME,
      password: appConfig.REMNAWAVE_PASSWORD
    });
    this.token = data.response.accessToken;
  }

  private async request<T>(method: "get" | "post" | "patch" | "delete", url: string, body?: unknown): Promise<T> {
    await this.ensureAuth();
    try {
      const { data } = await this.client.request<T>({
        method,
        url,
        data: body,
        headers: { Authorization: `Bearer ${this.token}` }
      });
      return data;
    } catch (error: any) {
      if (error?.response?.status === 401 && !this.staticApiToken) {
        this.token = null;
        await this.ensureAuth();
        const { data } = await this.client.request<T>({
          method,
          url,
          data: body,
          headers: { Authorization: `Bearer ${this.token}` }
        });
        return data;
      }
      throw error;
    }
  }

  private async getUsersByTelegramId(telegramId: number): Promise<RemnawaveUser[]> {
    const data = await this.request<RemnawaveListResp<ApiUser>>("get", `/api/users/by-telegram-id/${telegramId}`);
    return (data.response ?? []).map((u) => this.mapUser(u));
  }

  private pickBestByExpiry(users: RemnawaveUser[]): RemnawaveUser | null {
    if (!users.length) return null;
    const sorted = [...users].sort((a, b) => {
      const ta = new Date(a.expireAt).getTime();
      const tb = new Date(b.expireAt).getTime();
      const va = Number.isFinite(ta) ? ta : 0;
      const vb = Number.isFinite(tb) ? tb : 0;
      return vb - va;
    });
    return sorted[0] ?? null;
  }

  async getByTelegramId(telegramId: number): Promise<RemnawaveUser | null> {
    // Strict paid-only resolver: trial users are never used in paid lifecycle.
    const users = await this.getUsersByTelegramId(telegramId);
    if (!users.length) return null;
    const paidTagged = users.filter((u) => (u.tag ?? "").toUpperCase() === "PAID");
    return this.pickBestByExpiry(paidTagged);
  }

  async createUser(input: {
    telegramId: number;
    username: string;
    durationDays: number;
    trafficLimitBytes: number;
  }): Promise<RemnawaveUser> {
    const expireAt = new Date(Date.now() + input.durationDays * 24 * 60 * 60 * 1000).toISOString();
    const publicSquadUuid = await this.getPublicInternalSquadUuid();
    if (!publicSquadUuid) {
      throw new Error("Internal squad PUBLIC not found in Remnawave");
    }
    const payload = {
      username: input.username,
      telegramId: input.telegramId,
      tag: "PAID",
      expireAt,
      trafficLimitBytes: input.trafficLimitBytes,
      hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT,
      trafficLimitStrategy: "MONTH",
      activeInternalSquads: [publicSquadUuid]
    };
    try {
      const data = await this.request<RemnawaveObjResp<ApiUser>>("post", "/api/users", payload);
      return this.mapUser(data.response);
    } catch (error: any) {
      const errText = error?.response?.data ? JSON.stringify(error.response.data) : String(error?.message ?? "");
      // A019: username already exists -> retry once with unique suffix.
      if (!errText.includes("A019")) throw error;
      const base = input.username.slice(0, 28);
      const suffix = Math.random().toString(36).slice(2, 8);
      const retryPayload = {
        ...payload,
        username: `${base}_${suffix}`.slice(0, 36)
      };
      const retryData = await this.request<RemnawaveObjResp<ApiUser>>("post", "/api/users", retryPayload);
      return this.mapUser(retryData.response);
    }
  }

  async extendExistingUser(user: RemnawaveUser, addDays: number, trafficLimitBytes: number): Promise<RemnawaveUser> {
    const currentExpiry = new Date(user.expireAt).getTime();
    const from = Math.max(currentExpiry, Date.now());
    const expireAt = new Date(from + addDays * 24 * 60 * 60 * 1000).toISOString();
    const payloadWithTag = {
      uuid: user.uuid,
      tag: "PAID",
      expireAt,
      trafficLimitBytes,
      trafficLimitStrategy: "MONTH",
      hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT
    };
    try {
      const data = await this.request<RemnawaveObjResp<ApiUser>>("patch", "/api/users", payloadWithTag);
      return this.mapUser(data.response);
    } catch (error: any) {
      const status = Number(error?.response?.status ?? 0);
      if (status !== 400 && status !== 422) throw error;
      const payloadWithoutTag = {
        uuid: user.uuid,
        expireAt,
        trafficLimitBytes,
        trafficLimitStrategy: "MONTH",
        hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT
      };
      const data = await this.request<RemnawaveObjResp<ApiUser>>("patch", "/api/users", payloadWithoutTag);
      return this.mapUser(data.response);
    }
  }

  async provisionOrExtend(input: {
    telegramId: number;
    username: string;
    durationDays: number;
    trafficLimitBytes: number;
  }): Promise<RemnawaveUser> {
    const existingPaid = await this.getByTelegramId(input.telegramId);
    if (existingPaid) {
      return this.extendExistingUser(existingPaid, input.durationDays, input.trafficLimitBytes);
    }
    return this.createUser(input);
  }

  async getByUuid(uuid: string): Promise<RemnawaveUser | null> {
    const data = await this.request<RemnawaveObjResp<ApiUser>>("get", `/api/users/${uuid}`);
    if (!data?.response?.uuid) return null;
    return this.mapUser(data.response);
  }

  async createTrial(input: { telegramId: number; username: string; trialHours: number }): Promise<RemnawaveUser> {
    const expireAt = new Date(Date.now() + input.trialHours * 60 * 60 * 1000).toISOString();
    const publicSquadUuid = await this.getPublicInternalSquadUuid();
    if (!publicSquadUuid) {
      throw new Error("Internal squad PUBLIC not found in Remnawave");
    }
    const payload = {
      username: input.username,
      telegramId: input.telegramId,
      expireAt,
      trafficLimitBytes: appConfig.trialTrafficBytes,
      hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT,
      trafficLimitStrategy: "MONTH",
      tag: "TRIAL",
      activeInternalSquads: [publicSquadUuid]
    };
    const data = await this.request<RemnawaveObjResp<ApiUser>>("post", "/api/users", payload);
    return this.mapUser(data.response);
  }

  async revokeSubscription(uuid: string): Promise<void> {
    await this.request<ApiActionResponse>("post", `/api/users/${uuid}/actions/revoke`, {});
  }

  async disableUser(uuid: string): Promise<void> {
    await this.request<ApiActionResponse>("post", `/api/users/${uuid}/actions/disable`, {});
  }

  async enableUser(uuid: string): Promise<void> {
    await this.request<ApiActionResponse>("post", `/api/users/${uuid}/actions/enable`, {});
  }

  async resetTraffic(uuid: string): Promise<void> {
    await this.request<ApiActionResponse>("post", `/api/users/${uuid}/actions/reset-traffic`, {});
  }

  async deleteUser(uuid: string): Promise<void> {
    await this.request<ApiActionResponse>("delete", `/api/users/${uuid}`);
  }

  private async getPublicInternalSquadUuid(): Promise<string | null> {
    if (this.publicSquadUuid) return this.publicSquadUuid;
    const data = await this.request<any>("get", "/api/internal-squads");
    const squadsRaw = data?.response;
    const squads: ApiInternalSquad[] = Array.isArray(squadsRaw)
      ? squadsRaw
      : Array.isArray(squadsRaw?.items)
        ? squadsRaw.items
        : Array.isArray(squadsRaw?.internalSquads)
          ? squadsRaw.internalSquads
        : [];
    const publicSquad = squads.find((s) => {
      const n = (s.name ?? "").toUpperCase();
      const t = (s.title ?? "").toUpperCase();
      const g = (s.tag ?? "").toUpperCase();
      return n === "PUBLIC" || t === "PUBLIC" || g === "PUBLIC";
    });
    this.publicSquadUuid = publicSquad?.uuid ?? null;
    return this.publicSquadUuid;
  }

  private mapUser(u: ApiUser): RemnawaveUser {
    return {
      uuid: u.uuid,
      shortUuid: u.shortUuid,
      username: u.username,
      tag: u.tag ?? null,
      expireAt: u.expireAt,
      subscriptionUrl: u.subscriptionUrl,
      trafficLimitBytes: u.trafficLimitBytes
    };
  }
}
