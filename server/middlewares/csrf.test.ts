import Koa from "koa";
import { CSRF } from "@shared/constants";
import env from "@server/env";
import onerror from "@server/onerror";
import TestServer from "@server/test/TestServer";
import type { AppState } from "@server/types";
import { bundleToken, unbundleToken } from "@server/utils/csrf";
import { attachCSRFToken, verifyCSRFToken } from "./csrf";

const app = new Koa<AppState>();
app.proxy = true;
onerror(app);
app.use(attachCSRFToken());
app.use(verifyCSRFToken());
app.use((ctx) => {
  ctx.status = 204;
});
const server = new TestServer(app);
afterAll(() => server.close());

describe("CSRF token lifetime across concurrent table views", () => {
  it("keeps a valid token stable while other pages load", async () => {
    const token = bundleToken(Buffer.alloc(16, 1), env.SECRET_KEY);
    const headers = {
      cookie: `${CSRF.cookieName}=${token}; accessToken=test-session`,
    };
    const reads = await Promise.all([
      server.get("/one", { headers }),
      server.get("/two", { headers }),
    ]);
    expect(reads.map((response) => response.status)).toEqual([204, 204]);
    expect(reads.every((response) => !response.headers.get("set-cookie"))).toBe(
      true
    );
    const save = await server.post("/save", {
      headers: { ...headers, [CSRF.headerName]: token },
    });
    expect(save.status).toBe(204);
  });

  it("replaces an invalid cookie with a signed host-only cookie on HTTPS", async () => {
    const result = await server.get("/", {
      headers: {
        "x-forwarded-proto": "https",
        cookie: `${CSRF.secureCookieName}=invalid`,
      },
    });
    const cookie = result.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${CSRF.secureCookieName}=`);
    expect(cookie).toMatch(/; secure/i);
    expect(cookie).toMatch(/; samesite=lax/i);
    expect(cookie).not.toMatch(/; domain=/i);
    expect(
      unbundleToken(
        cookie.split(";")[0].slice(CSRF.secureCookieName.length + 1),
        env.SECRET_KEY
      ).valid
    ).toBe(true);
  });

  it("still rejects missing, invalid and mismatched request tokens", async () => {
    const token = bundleToken(Buffer.alloc(16, 1), env.SECRET_KEY);
    const other = bundleToken(Buffer.alloc(16, 2), env.SECRET_KEY);
    for (const supplied of [undefined, "invalid", other]) {
      const response = await server.post("/save", {
        headers: {
          cookie: `${CSRF.cookieName}=${token}; accessToken=test-session`,
          ...(supplied && { [CSRF.headerName]: supplied }),
        },
      });
      expect(response.status).toBe(403);
    }
  });
});
