import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from "baileys";
import { mkdirSync } from "node:fs";
import { log } from "../logger.ts";
import type { WhatsAppConfig } from "./types.ts";

export type MessageSource = "history" | "live";

export interface WhatsAppClientHandlers {
  /** Called with each new QR string while pairing. Render it for the user. */
  onQr?: (qr: string) => void;
  /** Called once the socket is open and the group subject map is populated. */
  onOpen?: () => void;
  /**
   * Called on every connection close — both the reconnect path and the
   * logged-out path — before anything is scheduled. Lets the caller re-gate
   * ingestion until the next `onOpen` (group map refreshed), so batches that
   * arrive on a fresh socket before the map is ready don't process stale.
   */
  onConnectionClose?: () => void;
  /** Called when WhatsApp logs the device out — re-pairing is required, no reconnect. */
  onLoggedOut?: () => void;
  /** Called for every batch of messages (backfill + live). */
  onMessages: (messages: WAMessage[], source: MessageSource) => void;
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;
/** Retry cadence for the post-open group-map refresh when the fetch fails. */
const GROUP_REFRESH_RETRY_MS = 30_000;

/**
 * Owns the Baileys socket lifecycle: pairing (QR), reconnect with backoff,
 * history backfill, live messages, and a fresh jid→subject map for group
 * filtering. Read-only — no send path exists in this phase.
 */
export class WhatsAppClient {
  private sock: WASocket | null = null;
  private groupNames = new Map<string, string>();
  private reconnectAttempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private groupRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private groupRefreshAttempts = 0;
  // Bumped whenever a refresh cycle should be abandoned (connection close, stop,
  // or a fresh "open"). An in-flight attempt captures the token and bails if it
  // no longer matches, so a stale fetch can't fire onOpen or reschedule.
  private groupRefreshToken = 0;

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly handlers: WhatsAppClientHandlers,
  ) {}

  /** Resolve a group JID to its current subject, if known. */
  getGroupName(groupJid: string): string | undefined {
    return this.groupNames.get(groupJid);
  }

  /** Snapshot of all known group JID→subject pairs. */
  getGroups(): Map<string, string> {
    return new Map(this.groupNames);
  }

  /** Connect and wire event handlers. Resolves once the socket is created. */
  async connect(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.config.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(
      this.config.authDir,
    );

    const logger = makeSilentLogger();
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      // Do NOT override `browser`: WhatsApp rejects unpaired DESKTOP-class
      // registrations at handshake (endless 428 pre-QR loop — the standalone
      // desktop app is discontinued), and custom names get the same treatment
      // unreliably. Baileys' default macOS/Chrome web signature is the one
      // registration path the server accepts.
      // Deep history backfill at pairing (v7 default, pinned here on purpose:
      // the buildathon groups predate pairing and we want their backlog).
      // Depth ultimately depends on what the phone sends a web-class device —
      // check the oldest stored message after pairing; fall back to
      // fetchMessageHistory paging or a chat-export import if it's too shallow.
      syncFullHistory: true,
      // Read-only device: don't announce presence to the groups.
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && this.handlers.onQr) {
        this.handlers.onQr(qr);
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.startGroupRefresh();
        return;
      }

      if (connection === "close") {
        // Abandon any in-flight/pending group refresh — a reconnect's own
        // "open" handler starts a fresh attempt. Buffered messages keep waiting.
        this.abandonGroupRefresh();
        // Re-gate ingestion before scheduling anything: on both the reconnect
        // and logged-out paths, no more batches should process until the next
        // "open" confirms a refreshed group map.
        this.handlers.onConnectionClose?.();
        const statusCode = disconnectStatusCode(lastDisconnect?.error);
        if (statusCode === DisconnectReason.loggedOut) {
          log.error(
            "whatsapp",
            "Device logged out — re-pairing needed. Run `bun run src/whatsapp/pair.ts` to scan a new QR. Not reconnecting.",
          );
          this.handlers.onLoggedOut?.();
          return;
        }
        this.scheduleReconnect(statusCode);
      }
    });

    sock.ev.on("messaging-history.set", ({ messages }) => {
      if (messages.length > 0) {
        this.handlers.onMessages(messages, "history");
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      if (messages.length > 0) {
        this.handlers.onMessages(messages, "live");
      }
    });

    sock.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (update.id && typeof update.subject === "string") {
          this.groupNames.set(update.id, update.subject);
        }
      }
    });

    sock.ev.on("groups.upsert", (groups) => {
      this.indexGroups(groups);
    });
  }

  /** Cleanly end the socket. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abandonGroupRefresh();
    if (this.sock) {
      try {
        await this.sock.end(undefined);
      } catch (err) {
        log.warn(
          "whatsapp",
          `error ending socket: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.sock = null;
    }
  }

  /**
   * Start (or restart) the post-open group-map refresh cycle. Only fires
   * `onOpen` once a refresh has actually SUCCEEDED — a failed fetch must not
   * open the gate, whether the map is empty (cold start: buffered backfill
   * would be flushed into a filter that rejects everything) or stale from
   * before a reconnect (groups joined/renamed during the disconnect would be
   * dropped or mislabeled). Messages keep buffering while we retry.
   */
  private startGroupRefresh(): void {
    this.clearGroupRefreshTimer();
    this.groupRefreshAttempts = 0;
    const token = ++this.groupRefreshToken;
    void this.attemptGroupRefresh(token);
  }

  private async attemptGroupRefresh(token: number): Promise<void> {
    if (this.stopped || token !== this.groupRefreshToken) return;
    this.groupRefreshAttempts += 1;
    const fetched = await this.refreshGroups();
    // The connection may have closed (or we stopped) while the fetch was in
    // flight — bail so a stale attempt can't open the gate or reschedule.
    if (this.stopped || token !== this.groupRefreshToken) return;

    // Gate criterion: a SUCCESSFUL fetch — the map now reflects current group
    // membership/subjects. Stale pre-disconnect entries are not good enough
    // (groups joined/renamed during the disconnect would drop or mislabel the
    // buffered messages), so a failed refresh always retries instead.
    if (fetched) {
      this.groupRefreshAttempts = 0;
      this.handlers.onOpen?.();
      return;
    }

    // Fetch failed — keep buffering and retry until the map is fresh.
    log.warn(
      "whatsapp",
      `group refresh failed (attempt ${this.groupRefreshAttempts}) — gate stays closed (buffering), retrying in ${GROUP_REFRESH_RETRY_MS}ms`,
    );
    this.groupRefreshTimer = setTimeout(() => {
      this.groupRefreshTimer = null;
      void this.attemptGroupRefresh(token);
    }, GROUP_REFRESH_RETRY_MS);
  }

  /** Invalidate any in-flight/pending refresh cycle and clear its timer. */
  private abandonGroupRefresh(): void {
    this.groupRefreshToken += 1;
    this.clearGroupRefreshTimer();
  }

  private clearGroupRefreshTimer(): void {
    if (this.groupRefreshTimer) {
      clearTimeout(this.groupRefreshTimer);
      this.groupRefreshTimer = null;
    }
  }

  /** Fetch participating groups into the map. Returns whether the fetch succeeded. */
  private async refreshGroups(): Promise<boolean> {
    if (!this.sock) return false;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      this.indexGroups(Object.values(groups));
      log.info(
        "whatsapp",
        `connected — ${this.groupNames.size} participating groups indexed`,
      );
      return true;
    } catch (err) {
      log.warn(
        "whatsapp",
        `groupFetchAllParticipating failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private indexGroups(groups: Array<Partial<GroupMetadata>>): void {
    for (const group of groups) {
      if (group.id && typeof group.subject === "string") {
        this.groupNames.set(group.id, group.subject);
      }
    }
  }

  private scheduleReconnect(statusCode: number | undefined): void {
    if (this.stopped) return;
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** this.reconnectAttempts,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts += 1;
    log.warn(
      "whatsapp",
      `connection closed (status=${statusCode ?? "unknown"}) — reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((err) => {
        log.error(
          "whatsapp",
          `reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleReconnect(undefined);
      });
    }, delay);
  }
}

/** Read the HTTP-style status code Baileys attaches to disconnect Boom errors. */
function disconnectStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "output" in error) {
    const output = (error as { output?: { statusCode?: number } }).output;
    return output?.statusCode;
  }
  return undefined;
}

/**
 * Baileys requires an ILogger. A silent stub keeps its internal chatter out of
 * Junior's logs — the client logs the events we actually care about itself.
 */
function makeSilentLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}
