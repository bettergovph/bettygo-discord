import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

export const apiKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const provided = c.req.header("X-Api-Key");
  if (!provided || provided !== c.env.API_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};
