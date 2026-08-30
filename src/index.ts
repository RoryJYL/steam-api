import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AchievementDetailsGet } from "./endpoints/achievement-details";
import { SteamProfileGet } from "./endpoints/steam-profile";
import { setCachedProfile } from "./services/cache";
import { fetchSteamProfile } from "./services/steam";

const app = new Hono<{ Bindings: Env }>();

// 根据 ALLOWED_DOMAINS 配置访问控制
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowedDomainsRaw: string = c.env.ALLOWED_DOMAINS || "";
      if (allowedDomainsRaw.trim() === "*") {
        return "*";
      }

      const allowedDomains = allowedDomainsRaw
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);

      if (allowedDomains.length === 0) {
        return "";
      }

      const isAllowed = allowedDomains.some((domain) =>
        origin.includes(domain),
      );

      return isAllowed ? origin : "";
    },
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

const openapi = fromHono(app, {
  docs_url: "/",
});

openapi.get("/api/profile-summary", SteamProfileGet);
openapi.get("/api/achievement-details/:appId", AchievementDetailsGet);

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const profile = await fetchSteamProfile(
            env.STEAM_CACHE,
            env.STEAM_API_KEY,
            env.STEAM_ID64,
          );
          await setCachedProfile(env.STEAM_CACHE, profile);
        } catch (error) {
          console.error("Scheduled refresh failed", error);
          throw error;
        }
      })(),
    );
  },
};
