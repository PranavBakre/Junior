import { describe, expect, it } from "bun:test";
import type { Config } from "../../config.ts";
import { InMemorySessionStore } from "../../session/store/memory.ts";
import type { UsageStore } from "../../usage/store/interface.ts";
import type { DashboardAuditStore } from "../audit/interface.ts";
import { handleHealth } from "./health.ts";

const config = {
  repos: [],
  pipeline: {
    runtimeMode: "off",
    bugPipelineEnabled: false,
    productPipelineEnabled: false,
  },
  github: {
    reconcileEnabled: false,
    eventWakeEnabled: false,
  },
} as unknown as Config;

describe("handleHealth", () => {
  it("uses store count APIs for spend and audit counters", async () => {
    const usageStore = {
      async count() {
        return 7;
      },
      async list() {
        throw new Error("health must not list usage rows");
      },
    } as unknown as UsageStore;
    const auditStore = {
      async count() {
        return 4;
      },
      async list() {
        throw new Error("health must not list audit rows");
      },
    } as unknown as DashboardAuditStore;

    const response = await handleHealth(
      new InMemorySessionStore(),
      config,
      new Date().toISOString(),
      { usageStore, auditStore },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      spend: { eventsToday: 7 },
      audit: { writesToday: 4 },
    });
  });
});
