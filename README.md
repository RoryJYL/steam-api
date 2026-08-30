# steam-api

Cloudflare Worker that fetches Steam profile + achievement data and caches it in KV. Architecture mirrors the [playstation-network-api](https://github.com/rorytech/playstation-network-api) worker.

## Endpoints

- `GET /api/profile-summary` — Steam profile + perfect games (100% achievements) with counts. Optional `?refresh=true` to force refresh.
- `GET /api/achievement-details/:appId` — full achievement details for one game.

OpenAPI docs at `/`.

## Data flow

```
GetPlayerSummaries + GetOwnedGames (2 requests, parallel)
  → filter: has_community_visible_stats && playtime > 0
  → GetPlayerAchievements per game (rate limited, 300ms)
  → perfect game: earned == total > 0
  → incremental detail fetch (only new perfect games or earned count changed):
      GetSchemaForGame + GetGlobalAchievementPercentagesForApp
  → merge + write KV
```

## Cache structure (KV)

- `steam:profile:data` — profile summary + perfect games
- `steam:achievements:{appId}` — achievement details per game
- `steam:perfect_games_index` — perfect game index with earned snapshot

Cron pre-warms every 6 hours.

## Setup

1. Create KV namespace and paste its id into `wrangler.jsonc`:

```bash
wrangler kv namespace create STEAM_CACHE
```

2. Set `STEAM_ID64` in `wrangler.jsonc` `vars` (it is public info, found in Steam client → Account details).

3. Set the API key as a secret:

```bash
wrangler secret put STEAM_API_KEY
```

Get a Steam Web API key for free at <https://steamcommunity.com/dev/apikey>.

4. Make sure the tracked profile is public:
   Profile → Edit Profile → Privacy Settings → Game details: Public.

5. Deploy:

```bash
wrangler deploy
```

## Local dev

```bash
pnpm install
# optional: put STEAM_API_KEY / STEAM_ID64 in .dev.vars
wrangler dev --kv STEAM_CACHE
```

First request to `/api/profile-summary` will crawl all games (rate limited, ~300ms per game).
