import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { Config } from "../config.ts";
import { resolvePublicStaticPath, startHttpServer, type HttpServerDeps } from "./server.ts";

const PUBLIC_JS_API = resolve(import.meta.dirname, "../../public/js/api.js");

function stubDeps(): HttpServerDeps {
  return {
    store: {} as HttpServerDeps["store"],
    config: { http: { enabled: true, port: 0 } } as Config,
    devServerManager: {} as HttpServerDeps["devServerManager"],
    devServerQueue: {} as HttpServerDeps["devServerQueue"],
    repos: [],
    workflowRegistry: {} as HttpServerDeps["workflowRegistry"],
    workflowScheduler: {} as HttpServerDeps["workflowScheduler"],
    workflowStore: {} as HttpServerDeps["workflowStore"],
    pipelineStore: {} as HttpServerDeps["pipelineStore"],
    usageStore: {} as HttpServerDeps["usageStore"],
    auditStore: {} as HttpServerDeps["auditStore"],
    sessionManager: {
      injectDashboardContinue: async () => ({ status: "accepted" }),
      interruptThread: async () => 0,
      isAdmin: async () => true,
      isExplicitAdmin: async () => false,
      getSession: async () => undefined,
    },
    slackPoster: {
      post: async () => ({ ts: "1.1" }),
    },
  };
}

describe("resolvePublicStaticPath", () => {
  it("resolves a real /js/* file under public/", () => {
    expect(resolvePublicStaticPath("/js/api.js")).toBe(PUBLIC_JS_API);
  });

  it("rejects traversal, encoded dots, and null-byte paths", () => {
    expect(resolvePublicStaticPath("/js/../index.html")).toBeNull();
    expect(resolvePublicStaticPath("/js/%2e%2e/index.html")).toBeNull();
    expect(resolvePublicStaticPath("/js/%2e%2e%2findex.html")).toBeNull();
    expect(resolvePublicStaticPath("/js/foo\0.js")).toBeNull();
    expect(resolvePublicStaticPath("/js/api.js\0")).toBeNull();
  });
});

describe("startHttpServer public /js/*", () => {
  let server: ReturnType<typeof startHttpServer> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  it("serves /js/api.js and 404s traversal shapes", async () => {
    server = startHttpServer(stubDeps());
    const base = `http://127.0.0.1:${server.port}`;

    const ok = await fetch(`${base}/js/api.js`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(ok.headers.get("cache-control")).toBe("no-cache");
    expect(await ok.text()).toContain("async function safeFetch");

    // fetch()/URL collapse `/js/../index.html` and `/js/%2e%2e/index.html` to
    // `/index.html`. `%2e%2e%2f` and `%00` are the shapes that still reach the
    // static guard; the helper above covers the literal `..` / null-byte forms.
    const encoded = await fetch(`${base}/js/%2e%2e%2findex.html`);
    expect(encoded.status).toBe(404);

    const nullByte = await fetch(`${base}/js/foo%00.js`);
    expect(nullByte.status).toBe(404);
  });
});
