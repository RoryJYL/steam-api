import type { Context } from "hono";
import { z } from "zod";

export type AppContext = Context<{ Bindings: Env }>;

export const SteamProfile = z.object({
  steamId: z.string(),
  personaName: z.string(),
  avatarUrl: z.string(),
  profileUrl: z.string(),
  totalAchievements: z.number(),
  perfectGames: z.array(
    z.object({
      appId: z.number(),
      name: z.string(),
      iconUrl: z.string(),
      playtimeMinutes: z.number(),
      lastPlayed: z.string(),
      earnedAchievements: z.number(),
      totalAchievements: z.number(),
      achievementDetails: z
        .object({
          achievements: z.array(z.unknown()),
          updatedAt: z.string(),
        })
        .optional(), // Optional: may not be cached yet
    }),
  ),
});

export type SteamProfileData = z.infer<typeof SteamProfile>;

export const SteamPresence = z.object({
  // 只有 personastate === 1 才算在线，忙碌/离开/打盹一概折算成 offline
  onlineStatus: z.enum(["online", "offline"]),
  game: z
    .object({
      // 非 Steam 快捷方式没有 appId
      appId: z.number().nullable(),
      title: z.string(),
      imageUrl: z.string().nullable(),
      playtimeMinutes: z.number().nullable(),
    })
    .nullable(),
  lastLogoff: z.string().nullable(),
  fetchedAt: z.string(),
});

export type SteamPresenceData = z.infer<typeof SteamPresence>;
