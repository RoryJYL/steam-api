import type { SteamProfileData } from "../types";

const CACHE_KEY = "steam:profile:data";

export interface GameProgressSnapshot {
  earned: number;
  total: number;
}

interface CachedData {
  data: SteamProfileData;
  timestamp: number;
  progress?: Record<string, GameProgressSnapshot>;
}

export async function getCachedProfile(
  kv: KVNamespace,
): Promise<CachedData | null> {
  const cached = await kv.get<CachedData>(CACHE_KEY, "json");

  if (!cached) {
    return null;
  }

  return cached;
}

export async function setCachedProfile(
  kv: KVNamespace,
  data: SteamProfileData,
  progress: Record<string, GameProgressSnapshot>,
): Promise<void> {
  const cached: CachedData = {
    data,
    timestamp: Date.now(),
    progress,
  };

  await kv.put(CACHE_KEY, JSON.stringify(cached));
}
