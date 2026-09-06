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
import {
  type GameProgressSnapshot,
  getCachedProfile,
  setCachedProfile,
} from "./cache";

const API_BASE = "https://api.steampowered.com";

// Steam 客户端游戏库横幅图，3840x1240，所有游戏都存在
// 注意：不能用 header.jpg（460x215 商店图），部分新游戏/小游戏没有该资源会 404
// （如 Servant of the Lake / appid 3636770），商店页实际用的是带 hash 的路径
const APP_IMAGE_BASE = "https://cdn.cloudflare.steamstatic.com/steam/apps";
// 成就图标统一用社区 assets 路径（新旧游戏均有效）
// 注意：schema 返回的 icon 可能是纯 hash，也可能是带旧版路径的完整 URL
// （旧路径 steamcommunity/public/images/apps 对部分新游戏是死链，
// 如 Servant of the Lake，社区页面实际用的是 community_assets 路径）
const ACHIEVEMENT_IMAGE_BASE =
  "https://shared.akamai.steamstatic.com/community_assets/images/apps";

const RATE_LIMIT_MS = 300;

// 免费计划 Worker 每次调用最多 50 个子请求，装不下全部候选游戏。
// 成就只会在游玩时变化，所以每轮只抓最近玩过的前 N 个游戏，
// 其余沿用 KV 里的进度快照。预算：2(概况+游戏库) + N(首轮) + 失败重试 + 详情 ≈ 50
const REFRESH_BATCH_SIZE = 30;

/**
 * GetSchemaForGame 的 icon 字段可能是纯 hash，也可能是完整 URL，统一提取 hash
 * 走 community_assets 通用路径（旧版 steamcommunity 路径对部分新游戏是死链）
 */
function normalizeAchievementIconUrl(appId: number, icon: string): string {
  const hash = icon
    .split("/")
    .pop()
    ?.replace(/\.(jpg|png)$/, "");
  if (!hash) {
    return "";
  }
  return `${ACHIEVEMENT_IMAGE_BASE}/${appId}/${hash}.jpg`;
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
  const url = `${API_BASE}${path}?${search.toString()}`;

  // Steam API 经常瞬时抽风（连接被重置/429/5xx），统一重试最多 3 次
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await sleep(1000 * (attempt - 1));
    }

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      // workerd 对网络层失败的 error.message 是空的，必须拼出可读信息
      lastError = `request failed: ${
        error instanceof Error && error.message ? error.message : String(error)
      }`;
      continue;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }
    lastError = `HTTP ${response.status}`;
  }

  throw new Error(`Steam API ${path} failed: ${lastError}`);
}

/**
 * 从商店 API 获取 header_image（带游戏标题艺术）。
 * 无商店页（下架/锁区）时返回空串，调用方回退到 hero 图。
 */
async function fetchStoreHeaderImage(appId: number): Promise<string> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`,
    );
    if (!response.ok) {
      return "";
    }
    const data = (await response.json()) as Record<
      string,
      { success: boolean; data?: { header_image?: string } }
    >;
    const entry = data[String(appId)];
    if (!entry?.success) {
      return "";
    }
    return entry.data?.header_image ?? "";
  } catch (error) {
    console.error(`appdetails failed for ${appId}:`, error);
    return "";
  }
}

/**
 * 获取候选游戏的全成就状态，逐游戏限流请求
 */
async function fetchAchievementProgress(
  apiKey: string,
  steamId: string,
  candidates: SteamOwnedGame[],
): Promise<{
  progressMap: Map<number, SteamAchievementProgress[]>;
  failures: Set<number>;
}> {
  const progressMap = new Map<number, SteamAchievementProgress[]>();
  const failures = new Set<number>();

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
      failures.add(game.appid);
      console.error(`GetPlayerAchievements failed for ${game.appid}:`, error);
    }
    if (i < candidates.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log(
    `成就进度获取完成: ${progressMap.size}/${candidates.length} 个游戏成功` +
      (failures.size > 0 ? `, ${failures.size} 个失败(保留旧数据)` : ""),
  );

  return { progressMap, failures };
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
  const toFetch = perfectGames.filter(({ game, earned, progress }) => {
    if (progress.length === 0) {
      // 进度来自旧快照（本次抓取失败），没有成就列表可组装详情，跳过
      return false;
    }
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

      const [schema, percentages, headerImageUrl] = await Promise.all([
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
        fetchStoreHeaderImage(game.appid),
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
        headerImageUrl,
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
): Promise<void> {
  const previous = await getCachedProfile(kv);

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

  // 只抓最近玩过的一批游戏，其余沿用旧快照
  const freshWindow = [...candidates]
    .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
    .slice(0, REFRESH_BATCH_SIZE);

  const { progressMap } = await fetchAchievementProgress(
    apiKey,
    steamId,
    freshWindow,
  );

  // 以旧快照为底：不在刷新窗口内的游戏保留上次数据，
  // 窗口内抓取失败的也保留旧数据——刷新永远不会让缓存比之前更差
  const merged = new Map<
    number,
    { earned: number; total: number; progress: SteamAchievementProgress[] }
  >();
  for (const game of candidates) {
    const last = previous?.progress?.[game.appid];
    if (last) {
      merged.set(game.appid, {
        earned: last.earned,
        total: last.total,
        progress: [],
      });
    }
  }
  for (const game of freshWindow) {
    const fresh = progressMap.get(game.appid);
    if (fresh) {
      merged.set(game.appid, {
        earned: fresh.filter((p) => p.achieved === 1).length,
        total: fresh.length,
        progress: fresh,
      });
    }
  }

  if (merged.size === 0) {
    if (previous) {
      // 本轮没拿到任何新数据（Steam 故障或统计不可见），保留旧缓存
      console.warn("Refresh got no data, keeping previous cache");
      return;
    }
    throw new Error(
      "No achievement progress returned, is the Steam profile's game details set to public?",
    );
  }

  // 全成就判定：earned == total > 0
  const perfectGames: PerfectGame[] = candidates
    .flatMap((game) => {
      const stats = merged.get(game.appid);
      return stats
        ? [
            {
              game,
              earned: stats.earned,
              total: stats.total,
              progress: stats.progress,
            },
          ]
        : [];
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
        iconUrl:
          details?.headerImageUrl ||
          `${APP_IMAGE_BASE}/${game.appid}/library_hero.jpg`,
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

  const totalAchievements = [...merged.values()].reduce(
    (sum, { earned }) => sum + earned,
    0,
  );

  const progressSnapshot: Record<string, GameProgressSnapshot> = {};
  for (const [appId, { earned, total }] of merged) {
    progressSnapshot[appId] = { earned, total };
  }

  await setCachedProfile(
    kv,
    {
      steamId: player.steamid,
      personaName: player.personaname,
      avatarUrl: player.avatarfull,
      profileUrl: player.profileurl,
      totalAchievements,
      perfectGames: perfectGamesWithDetails,
    },
    progressSnapshot,
  );
}
