import { fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AchievementDetailsGet } from "./endpoints/achievement-details";
import { SteamPresenceGet } from "./endpoints/presence";
import { SteamProfileGet } from "./endpoints/steam-profile";
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

      if (allowedDomains.length === 0 || !origin) {
        return "";
      }

      // 按 host 匹配：用 origin.includes(domain) 的话，
      // `https://rorytech.com.evil.io` 也能过——白名单变成了子串搜索。
      // 保留子域能力（`rorytech.com` 匹配 `blog.rorytech.com`），但要求在点号边界上。
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        return "";
      }

      const isAllowed = allowedDomains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
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
openapi.get("/api/presence", SteamPresenceGet);
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
          await fetchSteamProfile(
            env.STEAM_CACHE,
            env.STEAM_API_KEY,
            env.STEAM_ID64,
          );
        } catch (error) {
          console.error("Scheduled refresh failed", error);
          throw error;
        }
      })(),
    );
  },
};
