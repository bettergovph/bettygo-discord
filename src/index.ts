import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth";
import users from "./routes/users";
import { apiKey } from "./middleware/apiKey";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const origin = c.env.ALLOWED_ORIGIN || "*";
  return cors({
    origin,
    allowMethods: ["GET", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Api-Key"],
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

// /auth/login is protected; /auth/callback is public (browser redirect from Discord)
app.use("/auth/login", apiKey);
app.route("/auth", auth);

// All /users routes are protected
app.use("/users/*", apiKey);
app.route("/users", users);

export default app;
