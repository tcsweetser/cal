import { Hono } from "hono";
import type { AppBindings } from "../types";
import { LoginPage } from "../views/login";
import { PrivacyPage } from "../views/privacy";

const publicRoutes = new Hono<AppBindings>();

publicRoutes.get("/login", (c) => c.html(<LoginPage />));
publicRoutes.get("/privacy", (c) => c.html(<PrivacyPage />));

export default publicRoutes;
