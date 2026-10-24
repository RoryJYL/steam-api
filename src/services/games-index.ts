/**
 * 已玩游戏的轻量索引：appId -> { name, playtimeMinutes }
 *
 * presence 端点只拿得到 GetPlayerSummaries 的 gameid（gameextrainfo 还经常缺失），
 * 光靠它拼不出游戏名和总时长。cron 本来就在拉 GetOwnedGames，顺手存一份索引，
 * 让 presence 不用额外请求就能补全信息和「总时长」。
 */
export interface PlayedGameInfo {
  name: string;
  playtimeMinutes: number;
}

export type GamesIndex = Record<string, PlayedGameInfo>;

const GAMES_INDEX_KEY = "steam:games:index";

export async function getGamesIndex(kv: KVNamespace): Promise<GamesIndex> {
  return (await kv.get<GamesIndex>(GAMES_INDEX_KEY, "json")) ?? {};
}

export async function saveGamesIndex(
  kv: KVNamespace,
  index: GamesIndex,
): Promise<void> {
  await kv.put(GAMES_INDEX_KEY, JSON.stringify(index));
}
