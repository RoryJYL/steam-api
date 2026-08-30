/**
 * Steam achievement details cache management using Cloudflare KV
 *
 * Storage structure:
 * - "steam:achievements:{appId}" -> Achievement details for a single game
 * - "steam:perfect_games_index" -> Index of all perfect games
 */

export interface SteamAchievementDetail {
  name: string; // api name
  displayName: string;
  description: string;
  iconUrl: string;
  iconGrayUrl: string;
  hidden: boolean;
  achieved: boolean;
  unlockTime: string; // ISO date or ""
  percent: number; // global achievement rate
}

export interface AchievementDetails {
  achievements: SteamAchievementDetail[];
  updatedAt: string;
}

export interface PerfectGameIndexEntry {
  appId: number;
  name: string;
  earnedAchievements: number;
  totalAchievements: number;
}

export interface PerfectGamesIndex {
  games: PerfectGameIndexEntry[];
  lastUpdated: string;
}

const ACHIEVEMENT_DETAILS_PREFIX = "steam:achievements:";
const PERFECT_INDEX_KEY = "steam:perfect_games_index";

/**
 * Get achievement details for a specific game
 */
export async function getAchievementDetails(
  kv: KVNamespace,
  appId: number,
): Promise<AchievementDetails | null> {
  const key = `${ACHIEVEMENT_DETAILS_PREFIX}${appId}`;
  return await kv.get<AchievementDetails>(key, "json");
}

/**
 * Save achievement details for a specific game
 */
export async function saveAchievementDetails(
  kv: KVNamespace,
  appId: number,
  details: AchievementDetails,
): Promise<void> {
  const key = `${ACHIEVEMENT_DETAILS_PREFIX}${appId}`;
  await kv.put(key, JSON.stringify(details));
}

/**
 * Get the perfect games index
 */
export async function getPerfectGamesIndex(
  kv: KVNamespace,
): Promise<PerfectGamesIndex> {
  const index = await kv.get<PerfectGamesIndex>(PERFECT_INDEX_KEY, "json");

  if (!index) {
    // Return empty index if not exists
    return {
      games: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  return index;
}

/**
 * Update the perfect games index
 */
export async function updatePerfectGamesIndex(
  kv: KVNamespace,
  games: PerfectGameIndexEntry[],
): Promise<void> {
  const index: PerfectGamesIndex = {
    games,
    lastUpdated: new Date().toISOString(),
  };

  await kv.put(PERFECT_INDEX_KEY, JSON.stringify(index));
}
