import axios, { type AxiosInstance } from "axios";
import { appConfig } from "./config.js";
import type { RemnawaveUser } from "./types.js";

type RemnawaveListResp<T> = { response: T[] };
type RemnawaveObjResp<T> = { response: T };

type ApiUser = {
  uuid: string;
  shortUuid: string;
  username: string;
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

  async getByTelegramId(telegramId: number): Promise<RemnawaveUser | null> {
    const data = await this.request<RemnawaveListResp<ApiUser>>("get", `/api/users/by-telegram-id/${telegramId}`);
    if (!data.response.length) return null;
    const u = data.response[0];
    return this.mapUser(u);
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
      expireAt,
      trafficLimitBytes: input.trafficLimitBytes,
      hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT,
      trafficLimitStrategy: "MONTH",
      activeInternalSquads: [publicSquadUuid]
    };
    const data = await this.request<RemnawaveObjResp<ApiUser>>("post", "/api/users", payload);
    return this.mapUser(data.response);
  }

  async extendExistingUser(user: RemnawaveUser, addDays: number, trafficLimitBytes: number): Promise<RemnawaveUser> {
    const currentExpiry = new Date(user.expireAt).getTime();
    const from = Math.max(currentExpiry, Date.now());
    const expireAt = new Date(from + addDays * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      uuid: user.uuid,
      expireAt,
      trafficLimitBytes,
      trafficLimitStrategy: "MONTH",
      hwidDeviceLimit: appConfig.DEFAULT_HARDWARE_LIMIT
    };
    const data = await this.request<RemnawaveObjResp<ApiUser>>("patch", "/api/users", payload);
    return this.mapUser(data.response);
  }

  async provisionOrExtend(input: {
    telegramId: number;
    username: string;
    durationDays: number;
    trafficLimitBytes: number;
  }): Promise<RemnawaveUser> {
    const existing = await this.getByTelegramId(input.telegramId);
    if (!existing) {
      return this.createUser(input);
    }
    return this.extendExistingUser(existing, input.durationDays, input.trafficLimitBytes);
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
      trafficLimitBytes: appConfig.defaultTrafficBytes,
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
      expireAt: u.expireAt,
      subscriptionUrl: u.subscriptionUrl,
      trafficLimitBytes: u.trafficLimitBytes
    };
  }
}
