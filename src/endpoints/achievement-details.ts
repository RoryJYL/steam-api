import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { getAchievementDetails } from "../services/achievement-cache";
import type { AppContext } from "../types";

export class AchievementDetailsGet extends OpenAPIRoute {
  schema = {
    tags: ["Steam Achievement"],
    summary: "Get detailed achievement information for a specific game",
    request: {
      params: z.object({
        appId: z.string().describe("The Steam appId of the game"),
      }),
    },
    responses: {
      "200": {
        description: "Achievement details retrieved successfully",
        content: {
          "application/json": {
            schema: z.object({
              achievements: z
                .any()
                .describe("Full achievement data from Steam API"),
              updatedAt: z.string(),
            }),
          },
        },
      },
      "404": {
        description: "Achievement details not found",
        content: {
          "application/json": {
            schema: z.object({
              error: z.string(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const appIdParam = c.req.param("appId");

    if (!appIdParam) {
      return c.json({ error: "appId parameter is required" }, 400);
    }

    const appId = Number(appIdParam);
    if (Number.isNaN(appId)) {
      return c.json({ error: "appId must be a number" }, 400);
    }

    const details = await getAchievementDetails(c.env.STEAM_CACHE, appId);

    if (!details) {
      return c.json(
        {
          error: `Achievement details not found for ${appId}`,
        },
        404,
      );
    }

    return c.json(details);
  }
}
