#!/usr/bin/env bun
/**
 * WhatsApp pairing CLI.
 *
 *   bun run src/whatsapp/pair.ts
 *
 * Connects with Baileys, renders the pairing QR in the terminal, waits for the
 * link to complete, then prints the Hermes groups it can see and exits.
 * Read-only — pairs a linked device, sends nothing.
 *
 * Env (same defaults as the running subsystem):
 *   WHATSAPP_AUTH_DIR       (default data/whatsapp-auth)
 *   WHATSAPP_GROUP_PATTERN  (default "hermes")
 */
import qrcode from "qrcode-terminal";
import { WhatsAppClient } from "./client.ts";
import type { WhatsAppConfig } from "./types.ts";

function configFromEnv(): WhatsAppConfig {
  return {
    enabled: true,
    dbPath: process.env.WHATSAPP_DB_PATH ?? "data/whatsapp.db",
    authDir: process.env.WHATSAPP_AUTH_DIR ?? "data/whatsapp-auth",
    groupPattern: process.env.WHATSAPP_GROUP_PATTERN ?? "hermes",
    // Pairing is a one-shot CLI that never runs the extraction sweep — these
    // just satisfy the shared config type.
    extractionIntervalMs: 600_000,
    notionToken: null,
    notionPageId: process.env.HERMES_NOTION_PAGE_ID ?? "",
  };
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const groupPattern = new RegExp(config.groupPattern, "i");

  console.log("");
  console.log("=== WhatsApp pairing (Hermes tracker) ===");
  console.log(`Auth state dir : ${config.authDir}`);
  console.log(`Group pattern  : /${config.groupPattern}/i`);
  console.log("");
  console.log("If already paired, this reconnects and skips straight to the group list.");
  console.log("");

  let done = false;
  const finish = async (client: WhatsAppClient, code: number): Promise<void> => {
    if (done) return;
    done = true;
    await client.stop();
    process.exit(code);
  };

  const client = new WhatsAppClient(config, {
    onQr: (qr) => {
      console.log("Scan this QR from WhatsApp → Settings → Linked Devices → Link a Device:");
      console.log("");
      qrcode.generate(qr, { small: true });
      console.log("Waiting for you to scan…");
    },
    onLoggedOut: () => {
      console.error("");
      console.error("Device is logged out. Delete the auth dir and re-run to pair fresh:");
      console.error(`  rm -rf ${config.authDir} && bun run src/whatsapp/pair.ts`);
      void finish(client, 1);
    },
    onOpen: () => {
      const groups = client.getGroups();
      const matched = [...groups.entries()]
        .filter(([, subject]) => groupPattern.test(subject))
        .sort((a, b) => a[1].localeCompare(b[1]));

      console.log("");
      console.log("✅ Paired and connected.");
      console.log(`Visible groups: ${groups.size} total, ${matched.length} match /${config.groupPattern}/i`);
      console.log("");
      if (matched.length === 0) {
        console.log("No matching Hermes groups found yet.");
        console.log("- Confirm this number is a member of the buildathon groups.");
        console.log(`- Adjust WHATSAPP_GROUP_PATTERN if the group names differ from "${config.groupPattern}".`);
      } else {
        console.log("Matched Hermes groups:");
        for (const [jid, subject] of matched) {
          console.log(`  • ${subject}  (${jid})`);
        }
      }
      console.log("");
      console.log("Auth state is saved. The subsystem will reuse it — no re-scan needed.");
      void finish(client, 0);
    },
    onMessages: () => {
      // Pairing only lists groups; message ingestion is the subsystem's job.
    },
  });

  await client.connect();
}

main().catch((err) => {
  console.error(`Pairing failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
