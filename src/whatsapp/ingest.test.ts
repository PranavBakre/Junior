import { describe, expect, test } from "bun:test";
import type { WAMessage, proto } from "baileys";
import { ingestMessages, toWaMessage, type IngestDeps } from "./ingest.ts";
import type { WaMessageInput } from "./types.ts";

/** Collects upserts so tests can assert what ingestion decided to persist. */
function collector() {
  const persisted: WaMessageInput[] = [];
  return {
    persisted,
    store: { upsertMessage: (m: WaMessageInput) => persisted.push(m) },
  };
}

/**
 * Build deps with a Hermes-matching group map by default. `groups` maps
 * JID→subject; a JID absent from the map resolves to undefined (unknown group).
 */
function deps(
  store: IngestDeps["store"],
  groups: Record<string, string> = { "g1@g.us": "Hermes Bangalore" },
  pattern: string | null = "hermes",
): IngestDeps {
  return {
    store,
    groupPattern: pattern === null ? null : new RegExp(pattern, "i"),
    resolveGroupName: (jid) => groups[jid],
  };
}

interface FakeMsgOpts {
  id?: string;
  remoteJid?: string;
  participant?: string;
  pushName?: string | null;
  ts?: number | { toNumber(): number };
  message?: proto.IMessage | null;
}

/** Fabricate a Baileys-shaped WAMessage. The single cast is confined here. */
function fakeMessage(o: FakeMsgOpts = {}): WAMessage {
  return {
    key: {
      id: o.id ?? "m1",
      remoteJid: o.remoteJid ?? "g1@g.us",
      participant: o.participant ?? "sender@s.whatsapp.net",
      fromMe: false,
    },
    message: o.message === undefined ? { conversation: "hi" } : o.message,
    messageTimestamp: o.ts ?? 1000,
    pushName: o.pushName === undefined ? "Alice" : o.pushName,
  } as unknown as WAMessage;
}

describe("toWaMessage filtering", () => {
  test("persists a text message from a matching group", () => {
    const { store, persisted } = collector();
    const out = toWaMessage(fakeMessage(), deps(store));
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      id: "m1",
      groupJid: "g1@g.us",
      groupName: "Hermes Bangalore",
      senderJid: "sender@s.whatsapp.net",
      senderName: "Alice",
      ts: 1000,
      text: "hi",
      replyToId: null,
    });
    expect(persisted).toHaveLength(0); // toWaMessage does not persist
    expect(out?.raw).toContain("g1@g.us");
  });

  test("skips a group whose subject does not match the pattern", () => {
    const { store } = collector();
    const d = deps(store, { "g2@g.us": "Random Chat" });
    expect(toWaMessage(fakeMessage({ remoteJid: "g2@g.us" }), d)).toBeNull();
  });

  test("skips an unknown group (no resolved subject)", () => {
    const { store } = collector();
    const d = deps(store, {}); // nothing resolves
    expect(toWaMessage(fakeMessage(), d)).toBeNull();
  });

  test("skips direct messages (non-group JID)", () => {
    const { store } = collector();
    const d = deps(store, { "dm@s.whatsapp.net": "Hermes DM" });
    expect(
      toWaMessage(fakeMessage({ remoteJid: "dm@s.whatsapp.net" }), d),
    ).toBeNull();
  });

  test("skips messages with no text or caption", () => {
    const { store } = collector();
    // A reaction/protocol message carrying no renderable text.
    const empty = fakeMessage({ message: { protocolMessage: {} } });
    expect(toWaMessage(empty, deps(store))).toBeNull();
  });

  test("skips messages missing an id or remoteJid", () => {
    const { store } = collector();
    const noId = fakeMessage();
    (noId.key as { id: string | null }).id = null;
    expect(toWaMessage(noId, deps(store))).toBeNull();
  });

  test("matches group names case-insensitively", () => {
    const { store } = collector();
    const d = deps(store, { "g1@g.us": "HERMES buildathon" });
    expect(toWaMessage(fakeMessage(), d)).not.toBeNull();
  });

  test("a null pattern ingests any known group", () => {
    const { store } = collector();
    const d = deps(store, { "g2@g.us": "Random Chat" }, null);
    expect(toWaMessage(fakeMessage({ remoteJid: "g2@g.us" }), d)).not.toBeNull();
  });

  test("a null pattern still skips groups with no resolved subject", () => {
    const { store } = collector();
    const d = deps(store, {}, null);
    expect(toWaMessage(fakeMessage(), d)).toBeNull();
  });
});

describe("toWaMessage content extraction", () => {
  test("extracts extendedTextMessage.text", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: { extendedTextMessage: { text: "extended body" } },
    });
    expect(toWaMessage(m, deps(store))?.text).toBe("extended body");
  });

  test("extracts an image caption", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: { imageMessage: { caption: "a screenshot" } },
    });
    expect(toWaMessage(m, deps(store))?.text).toBe("a screenshot");
  });

  test("extracts a video caption", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: { videoMessage: { caption: "clip caption" } },
    });
    expect(toWaMessage(m, deps(store))?.text).toBe("clip caption");
  });

  test("extracts a document caption", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: { documentMessage: { caption: "spec.pdf notes" } },
    });
    expect(toWaMessage(m, deps(store))?.text).toBe("spec.pdf notes");
  });

  test("unwraps ephemeral messages", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: { ephemeralMessage: { message: { conversation: "disappearing" } } },
    });
    expect(toWaMessage(m, deps(store))?.text).toBe("disappearing");
  });

  test("reads reply_to_id from contextInfo.stanzaId", () => {
    const { store } = collector();
    const m = fakeMessage({
      message: {
        extendedTextMessage: {
          text: "a reply",
          contextInfo: { stanzaId: "quoted-msg-id" },
        },
      },
    });
    expect(toWaMessage(m, deps(store))?.replyToId).toBe("quoted-msg-id");
  });

  test("senderName is null when pushName is absent", () => {
    const { store } = collector();
    expect(toWaMessage(fakeMessage({ pushName: null }), deps(store))?.senderName).toBeNull();
  });

  test("normalizes a Long-like timestamp via toNumber", () => {
    const { store } = collector();
    const m = fakeMessage({ ts: { toNumber: () => 1_700_000_000 } });
    expect(toWaMessage(m, deps(store))?.ts).toBe(1_700_000_000);
  });
});

describe("ingestMessages", () => {
  test("persists only matching messages and returns the count", () => {
    const { store, persisted } = collector();
    const d = deps(store, {
      "g1@g.us": "Hermes Bangalore",
      "g2@g.us": "Random Chat",
    });
    const count = ingestMessages(
      [
        fakeMessage({ id: "a", remoteJid: "g1@g.us" }),
        fakeMessage({ id: "b", remoteJid: "g2@g.us" }), // non-matching group
        fakeMessage({ id: "c", remoteJid: "g1@g.us", message: null }), // no text
        fakeMessage({ id: "d", remoteJid: "g1@g.us" }),
      ],
      d,
    );
    expect(count).toBe(2);
    expect(persisted.map((m) => m.id)).toEqual(["a", "d"]);
  });
});
