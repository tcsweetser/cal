import { Hono } from "hono";
import type { AppBindings } from "../types";
import { LoginPage } from "../views/login";

const publicRoutes = new Hono<AppBindings>();

publicRoutes.get("/login", (c) => c.html(<LoginPage />));

export default publicRoutes;
