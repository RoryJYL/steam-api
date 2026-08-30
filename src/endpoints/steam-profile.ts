import { OpenAPIRoute, Str } from "chanfana";
import { z } from "zod";
import { getCachedProfile, setCachedProfile } from "../services/cache";
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
    const cacheTtl = Number(c.env.CACHE_TTL_SECONDS) || 43200;
    const cached = await getCachedProfile(c.env.STEAM_CACHE);

    if (!forceRefresh && cached) {
      const now = Date.now();
      const age = (now - cached.timestamp) / 1000;
      const isFresh = age <= cacheTtl;

      if (isFresh) {
        return c.json(cached.data);
      }
    }

    try {
      const profile = await fetchSteamProfile(
        c.env.STEAM_CACHE,
        apiKey,
        steamId,
      );
      await setCachedProfile(c.env.STEAM_CACHE, profile);
      return c.json(profile);
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
