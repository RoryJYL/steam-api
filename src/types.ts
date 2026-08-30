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
