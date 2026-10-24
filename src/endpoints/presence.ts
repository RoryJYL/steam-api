import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { getPresence } from "../services/presence";
import { type AppContext, SteamPresence } from "../types";

export class SteamPresenceGet extends OpenAPIRoute {
  schema = {
    tags: ["Steam"],
    summary: "Get Steam online status and currently playing game",
    responses: {
      "200": {
        description:
          "Presence snapshot (cached up to 5 minutes); null when unknown or stale",
        content: {
          "application/json": {
            schema: SteamPresence.nullable(),
          },
        },
      },
      "500": {
        description: "STEAM_API_KEY or STEAM_ID64 not configured",
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
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

    const presence = await getPresence(c.env.STEAM_CACHE, apiKey, steamId);

    // 数据本身就有 5 分钟 KV 窗口，再叠一层缓存只会让状态更陈旧。
    // workers.dev 也没有可供 Cache-Control 命中的共享缓存层。
    c.header("Cache-Control", "no-store");

    // schema 不只是写给 OpenAPI 看的：它能拓住 Steam API 的松散返回。
    // 校验不过只降级为 null（前端藏掉卡片），不该把整页拖下水。
    const parsed = SteamPresence.nullable().safeParse(presence);
    if (!parsed.success) {
      console.error("Steam presence shape mismatch", parsed.error);
      return c.json(null);
    }

    return c.json(parsed.data);
  }
}
