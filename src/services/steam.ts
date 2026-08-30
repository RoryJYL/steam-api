import type { SteamProfileData } from "../types";
import { sleep } from "../utils/rate-limiter";
import {
  type AchievementDetails,
  getAchievementDetails,
  getPerfectGamesIndex,
  type PerfectGamesIndex,
  type SteamAchievementDetail,
  saveAchievementDetails,
  updatePerfectGamesIndex,
} from "./achievement-cache";

const API_BASE = "https://api.steampowered.com";

// Steam 商店头图 CDN，460x215，卡片和展开详情共用
const APP_IMAGE_BASE = "https://cdn.cloudflare.steamstatic.com/steam/apps";
// 成就图标 CDN，hash 来自 GetSchemaForGame
const ACHIEVEMENT_IMAGE_BASE =
  "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps";

const RATE_LIMIT_MS = 300;

/**
 * GetSchemaForGame 的 icon 字段可能是纯 hash，也可能是完整 URL（不同游戏表现不一），统一处理
 */
function normalizeAchievementIconUrl(appId: number, icon: string): string {
  return icon.startsWith("http")
    ? icon
    : `${ACHIEVEMENT_IMAGE_BASE}/${appId}/${icon}.jpg`;
}

interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  avatarfull: string;
  profileurl: string;
}

interface SteamOwnedGame {
  appid: number;
  name: string;
  playtime_forever: number;
  has_community_visible_stats?: boolean;
  rtime_last_played: number;
}

interface SteamAchievementProgress {
  apiname: string;
  achieved: number;
  unlocktime: number;
}

interface SteamSchemaAchievement {
  name: string;
  displayName: string;
  description?: string;
  icon: string;
  icongray: string;
  hidden: number;
}

interface SteamGlobalPercent {
  name: string;
  // Steam 实际返回字符串，用 Number() 归一化
  percent: number | string;
}

interface PerfectGame {
  game: SteamOwnedGame;
  earned: number;
  total: number;
  progress: SteamAchievementProgress[];
}

async function steamApi<T>(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const search = new URLSearchParams({ key: apiKey, ...params });
  const response = await fetch(`${API_BASE}${path}?${search.toString()}`);

  if (!response.ok) {
    throw new Error(`Steam API ${path} failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * 获取候选游戏的全成就状态，逐游戏限流请求
 */
async function fetchAchievementProgress(
  apiKey: string,
  steamId: string,
  candidates: SteamOwnedGame[],
): Promise<Map<number, SteamAchievementProgress[]>> {
  const progressMap = new Map<number, SteamAchievementProgress[]>();

  for (let i = 0; i < candidates.length; i++) {
    const game = candidates[i];
    try {
      const stats = await steamApi<{
        playerstats: { achievements?: SteamAchievementProgress[] };
      }>(apiKey, "/ISteamUserStats/GetPlayerAchievements/v0001/", {
        steamid: steamId,
        appid: String(game.appid),
        l: "schinese",
      });
      if (stats.playerstats?.achievements) {
        progressMap.set(game.appid, stats.playerstats.achievements);
      }
    } catch (error) {
      // 单个游戏失败（无成就/私有）不影响整体，跳过
      console.error(`GetPlayerAchievements failed for ${game.appid}:`, error);
    }
    if (i < candidates.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  return progressMap;
}

/**
 * 增量更新新全成就游戏的成就详情
 *
 * 需要抓详情的两种情况：
 * 1. 不在索引里（新全成就游戏）
 * 2. 索引快照的 earned 数与当前不同（DLC 新增成就后重新全成就）
 */
async function updateNewPerfectGameDetails(
  kv: KVNamespace,
  apiKey: string,
  perfectGames: PerfectGame[],
  index: PerfectGamesIndex,
): Promise<void> {
  const existing = new Map(index.games.map((g) => [g.appId, g]));
  const toFetch = perfectGames.filter(({ game, earned }) => {
    const entry = existing.get(game.appid);
    return !entry || entry.earnedAchievements !== earned;
  });

  if (toFetch.length === 0) {
    return;
  }

  console.log(`发现 ${toFetch.length} 个需要更新成就详情的全成就游戏...`);

  for (let i = 0; i < toFetch.length; i++) {
    const { game, progress } = toFetch[i];
    try {
      console.log(`正在获取 ${game.name} 的成就详情...`);

      const [schema, percentages] = await Promise.all([
        steamApi<{
          game: {
            availableGameStats?: { achievements?: SteamSchemaAchievement[] };
          };
        }>(apiKey, "/ISteamUserStats/GetSchemaForGame/v0002/", {
          appid: String(game.appid),
          l: "schinese",
        }),
        steamApi<{
          achievementpercentages: { achievements: SteamGlobalPercent[] };
        }>(
          apiKey,
          "/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/",
          {
            gameid: String(game.appid),
          },
        ),
      ]);

      const schemaAchievements =
        schema.game.availableGameStats?.achievements ?? [];
      const percentMap = new Map(
        percentages.achievementpercentages.achievements.map((a) => [
          a.name,
          a.percent,
        ]),
      );
      const progressMap = new Map(progress.map((p) => [p.apiname, p]));

      const achievements: SteamAchievementDetail[] = schemaAchievements.map(
        (schemaAchievement) => {
          const playerStats = progressMap.get(schemaAchievement.name);
          const achieved = playerStats?.achieved === 1;
          return {
            name: schemaAchievement.name,
            displayName: schemaAchievement.displayName,
            description: schemaAchievement.description ?? "",
            iconUrl: normalizeAchievementIconUrl(
              game.appid,
              schemaAchievement.icon,
            ),
            iconGrayUrl: normalizeAchievementIconUrl(
              game.appid,
              schemaAchievement.icongray,
            ),
            hidden: schemaAchievement.hidden === 1,
            achieved,
            unlockTime: achieved
              ? new Date((playerStats?.unlocktime ?? 0) * 1000).toISOString()
              : "",
            percent: Number(percentMap.get(schemaAchievement.name) ?? 0),
          };
        },
      );

      const details: AchievementDetails = {
        achievements,
        updatedAt: new Date().toISOString(),
      };

      await saveAchievementDetails(kv, game.appid, details);

      if (i < toFetch.length - 1) {
        await sleep(RATE_LIMIT_MS);
      }
    } catch (error) {
      console.error(`获取 ${game.name} 详情失败:`, error);
    }
  }

  await updatePerfectGamesIndex(
    kv,
    perfectGames.map(({ game, earned, total }) => ({
      appId: game.appid,
      name: game.name,
      earnedAchievements: earned,
      totalAchievements: total,
    })),
  );
  console.log(`索引已更新，共 ${perfectGames.length} 个全成就游戏`);
}

export async function fetchSteamProfile(
  kv: KVNamespace,
  apiKey: string,
  steamId: string,
): Promise<SteamProfileData> {
  const [summaryResponse, gamesResponse] = await Promise.all([
    steamApi<{ response: { players: SteamPlayerSummary[] } }>(
      apiKey,
      "/ISteamUser/GetPlayerSummaries/v0002/",
      { steamids: steamId },
    ),
    steamApi<{ response: { games: SteamOwnedGame[] } }>(
      apiKey,
      "/IPlayerService/GetOwnedGames/v0001/",
      {
        steamid: steamId,
        include_appinfo: "1",
        include_played_free_games: "1",
        format: "json",
      },
    ),
  ]);

  const player = summaryResponse.response.players[0];
  if (!player) {
    throw new Error("Steam profile not found, is the profile public?");
  }

  const games = gamesResponse.response.games ?? [];

  // 有可见统计（成就）且玩过的游戏才是候选
  const candidates = games.filter(
    (g) => g.has_community_visible_stats && g.playtime_forever > 0,
  );

  const progressMap = await fetchAchievementProgress(
    apiKey,
    steamId,
    candidates,
  );

  if (candidates.length > 0 && progressMap.size === 0) {
    throw new Error(
      "No achievement progress returned, is the Steam profile's game details set to public?",
    );
  }

  // 全成就判定：earned == total > 0
  const perfectGames: PerfectGame[] = candidates
    .map((game) => {
      const progress = progressMap.get(game.appid) ?? [];
      return {
        game,
        earned: progress.filter((p) => p.achieved === 1).length,
        total: progress.length,
        progress,
      };
    })
    .filter(({ earned, total }) => earned === total && total > 0)
    .sort((a, b) => b.game.rtime_last_played - a.game.rtime_last_played);

  const index = await getPerfectGamesIndex(kv);
  await updateNewPerfectGameDetails(kv, apiKey, perfectGames, index);

  // 从 KV 读回详情组装 profile
  const perfectGamesWithDetails = await Promise.all(
    perfectGames.map(async ({ game, earned, total }) => {
      const details = await getAchievementDetails(kv, game.appid);
      return {
        appId: game.appid,
        name: game.name,
        iconUrl: `${APP_IMAGE_BASE}/${game.appid}/header.jpg`,
        playtimeMinutes: game.playtime_forever,
        lastPlayed: game.rtime_last_played
          ? new Date(game.rtime_last_played * 1000).toISOString()
          : "",
        earnedAchievements: earned,
        totalAchievements: total,
        achievementDetails: details
          ? {
              achievements: details.achievements.filter((a) => a.achieved),
              updatedAt: details.updatedAt,
            }
          : undefined,
      };
    }),
  );

  const totalAchievements = [...progressMap.values()].reduce(
    (sum, progress) => sum + progress.filter((p) => p.achieved === 1).length,
    0,
  );

  return {
    steamId: player.steamid,
    personaName: player.personaname,
    avatarUrl: player.avatarfull,
    profileUrl: player.profileurl,
    totalAchievements,
    perfectGames: perfectGamesWithDetails,
  };
}
