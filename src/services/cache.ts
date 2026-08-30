import type { SteamProfileData } from "../types";

const CACHE_KEY = "steam:profile:data";

interface CachedData {
  data: SteamProfileData;
  timestamp: number;
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
): Promise<void> {
  const cached: CachedData = {
    data,
    timestamp: Date.now(),
  };

  await kv.put(CACHE_KEY, JSON.stringify(cached));
}
