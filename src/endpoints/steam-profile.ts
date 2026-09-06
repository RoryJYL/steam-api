import { OpenAPIRoute, Str } from "chanfana";
import { z } from "zod";
import { getCachedProfile } from "../services/cache";
import { fetchSteamProfile } from "../services/steam";
import { type AppContext, SteamProfile } from "../types";

export class SteamProfileGet extends OpenAPIRoute {
  schema = {
    tags: ["Steam"],
    summary: "Get Steam profile with achievement statistics",
    request: {
      query: z.object({
        refresh: Str({
          description: "Set to 'true' to force cache refresh",
          required: false,
        }),
      }),
    },
    responses: {
      "200": {
        description: "Steam profile data",
        content: {
          "application/json": {
            schema: SteamProfile,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const apiKey = c.env.STEAM_API_KEY;
    const steamId = c.env.STEAM_ID64;
    if (!apiKey || !steamId) {
      return c.json(
        { error: "STEAM_API_KEY or STEAM_ID64 not configured" },
        500,
      );
    }

    const forceRefresh = c.req.query("refresh") === "true";
    const cached = await getCachedProfile(c.env.STEAM_CACHE);

    // 请求路径是纯读：有缓存就返回缓存，不管新旧。
    // 刷新职责归 cron（每 6 小时）和 ?refresh=true 手动触发；
    if (!forceRefresh && cached) {
      return c.json(cached.data);
    }

    try {
      await fetchSteamProfile(c.env.STEAM_CACHE, apiKey, steamId);
      const fresh = await getCachedProfile(c.env.STEAM_CACHE);
      if (fresh) {
        return c.json(fresh.data);
      }
      return c.json({ error: "Failed to fetch Steam profile" }, 502);
    } catch (error) {
      console.error("Failed to fetch Steam profile", error);
      // Return cached data if available
      if (cached) {
        return c.json(cached.data);
      }
      return c.json({ error: "Failed to fetch Steam profile" }, 502);
    }
  }
}
