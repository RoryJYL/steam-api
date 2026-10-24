import type { SteamPresenceData } from "../types";
import { type GamesIndex, getGamesIndex } from "./games-index";
import { resolveHeaderImageUrl, steamApi } from "./steam";

const PRESENCE_KEY = "steam:presence:snapshot";

/** 在线状态快照最长复用时间：5 分钟内不重复打 Steam（与前端轮询间隔一致） */
const PRESENCE_TTL_MS = 5 * 60 * 1000;
/** 拉取失败后的冷却时间，避免访客量把 Steam API 打到 429 */
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * 在线状态的最大可信年龄。
 *
 * 「正在玩」是此刻发生的事，不是历史。Steam 挂了或资料转了私密之后如果一直
 * 把上一份快照当现状展示，博客就会长期挂着一个假状态，比不显示糟得多。
 */
const PRESENCE_STALE_MS = 15 * 60 * 1000;

/** personastate 只有 1 是「在线」；2-6（忙碌/离开/打盹/想交易/想玩）在博客上没有信息量 */
const PERSONA_STATE_ONLINE = 1;

interface Snapshot {
  data: SteamPresenceData | null;
  fetchedAt: number;
  failUntil?: number;
}

interface SteamPlayerSummary {
  personastate?: number;
  gameid?: string;
  gameextrainfo?: string;
  lastlogoff?: number;
  communityvisibilitystate?: number;
}

async function readSnapshot(kv: KVNamespace): Promise<Snapshot | null> {
  return kv.get<Snapshot>(PRESENCE_KEY, "json");
}

async function writeSnapshot(
  kv: KVNamespace,
  snapshot: Snapshot,
): Promise<void> {
  await kv.put(PRESENCE_KEY, JSON.stringify(snapshot), {
    expirationTtl: 3600,
  });
}

/** 拉取失败：保留旧数据，但写入冷却期，避免每次请求都去撞 Steam */
async function markFailed(
  kv: KVNamespace,
  previous: Snapshot | null,
  now: number,
): Promise<Snapshot> {
  const next: Snapshot = {
    data: previous?.data ?? null,
    fetchedAt: previous?.fetchedAt ?? 0,
    failUntil: now + FAIL_COOLDOWN_MS,
  };
  await writeSnapshot(kv, next);
  return next;
}

/** 快照过期、或从未成功拉取过，都需要刷新 */
function needsRefresh(snapshot: Snapshot | null, now: number): boolean {
  if (!snapshot) return true;
  if (snapshot.failUntil && now < snapshot.failUntil) return false;
  return now - snapshot.fetchedAt >= PRESENCE_TTL_MS;
}

function toPresence(
  player: SteamPlayerSummary,
  games: GamesIndex,
  imageUrl: string | null,
  now: number,
): SteamPresenceData {
  // gameid 是字符串；非 Steam 快捷方式没有 gameid，"0" 也当没有
  const appId = Number(player.gameid) || null;
  const known = appId ? games[String(appId)] : undefined;

  // gameextrainfo 常常缺失（非 Steam 快捷方式、部分老游戏），名字从 cron 存的索引补
  const title =
    player.gameextrainfo ??
    known?.name ??
    (appId ? `Steam 游戏 #${appId}` : null);

  return {
    onlineStatus:
      player.personastate === PERSONA_STATE_ONLINE ? "online" : "offline",
    game: title
      ? {
          appId,
          title,
          imageUrl,
          playtimeMinutes: known?.playtimeMinutes ?? null,
        }
      : null,
    lastLogoff: player.lastlogoff
      ? new Date(player.lastlogoff * 1000).toISOString()
      : null,
    fetchedAt: new Date(now).toISOString(),
  };
}

async function refresh(
  kv: KVNamespace,
  apiKey: string,
  steamId: string,
  previous: Snapshot | null,
  now: number,
): Promise<Snapshot> {
  try {
    const [response, games] = await Promise.all([
      steamApi<{ response: { players: SteamPlayerSummary[] } }>(
        apiKey,
        "/ISteamUser/GetPlayerSummaries/v0002/",
        { steamids: steamId },
      ),
      // 索引只是锦上添花，读不到也照常出状态
      getGamesIndex(kv).catch(() => ({}) as GamesIndex),
    ]);

    const player = response.response.players[0];
    if (!player) {
      throw new Error("Steam profile not found, is the profile public?");
    }

    // 头图只是装饰：图源探测失败绝不能把整次 presence 刷新拖成失败
    const imageUrl = player.gameid
      ? await resolveHeaderImageUrl(kv, Number(player.gameid)).catch(
          (error) => {
            console.error("Failed to resolve header image", error);
            return null;
          },
        )
      : null;

    const next: Snapshot = {
      data: toPresence(player, games, imageUrl, now),
      fetchedAt: now,
    };
    await writeSnapshot(kv, next);
    return next;
  } catch (error) {
    console.error("Failed to fetch Steam presence", error);
    return markFailed(kv, previous, now);
  }
}

/**
 * 返回在线状态 + 正在玩的游戏。命中 KV 快照直接返回，过期才向 Steam 拉取。
 *
 * 任何一次失败都会进入冷却期，保证访客量不会把 Steam 打到 429；数据太旧或
 * 压根拿不到时返回 null，让前端把整块藏起来。
 */
export async function getPresence(
  kv: KVNamespace,
  apiKey: string,
  steamId: string,
): Promise<SteamPresenceData | null> {
  const now = Date.now();
  let snapshot = await readSnapshot(kv);

  if (needsRefresh(snapshot, now)) {
    snapshot = await refresh(kv, apiKey, steamId, snapshot, now);
  }

  if (!snapshot?.data) return null;

  if (now - snapshot.fetchedAt > PRESENCE_STALE_MS) {
    console.warn("Steam presence data is stale, hiding it");
    return null;
  }

  return snapshot.data;
}
