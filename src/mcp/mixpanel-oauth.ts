import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { MixpanelRegion } from "./mixpanel-proxy.ts";

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export const MIXPANEL_OAUTH_CALLBACK_PORT = Number(
  process.env.MIXPANEL_MCP_OAUTH_CALLBACK_PORT ?? "3458",
);
export const MIXPANEL_OAUTH_CALLBACK_URL =
  `http://127.0.0.1:${MIXPANEL_OAUTH_CALLBACK_PORT}/oauth/callback`;

export class MixpanelOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = MIXPANEL_OAUTH_CALLBACK_URL;
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: "Junior Mixpanel MCP proxy",
    redirect_uris: [MIXPANEL_OAUTH_CALLBACK_URL],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  private stored: StoredOAuthState = {};
  private readonly oauthState = randomBytes(32).toString("hex");

  private constructor(
    readonly region: MixpanelRegion,
    private readonly path: string,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
  ) {}

  static async create(
    region: MixpanelRegion,
    onRedirect: (url: URL) => void | Promise<void> = () => {
      throw new Error(`Mixpanel ${region.toUpperCase()} OAuth is not connected; run bun run mixpanel:oauth`);
    },
  ): Promise<MixpanelOAuthProvider> {
    const provider = new MixpanelOAuthProvider(region, oauthPath(region), onRedirect);
    try {
      provider.stored = JSON.parse(await readFile(provider.path, "utf8")) as StoredOAuthState;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }
    return provider;
  }

  state(): string { return this.oauthState; }
  expectedState(): string { return this.oauthState; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.stored.clientInformation; }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = value;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined { return this.stored.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> {
    this.stored.tokens = value;
    delete this.stored.codeVerifier;
    await this.persist();
  }
  redirectToAuthorization(url: URL): void | Promise<void> { return this.onRedirect(url); }
  async saveCodeVerifier(value: string): Promise<void> {
    this.stored.codeVerifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    if (!this.stored.codeVerifier) throw new Error(`Missing Mixpanel ${this.region} PKCE verifier`);
    return this.stored.codeVerifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.stored.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.stored.tokens;
    if (scope === "all" || scope === "verifier") delete this.stored.codeVerifier;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export async function hasMixpanelOAuthTokens(region: MixpanelRegion): Promise<boolean> {
  return Boolean((await MixpanelOAuthProvider.create(region)).tokens());
}

function oauthPath(region: MixpanelRegion): string {
  const root = resolve(process.env.MIXPANEL_MCP_OAUTH_DIR ?? "data/mixpanel-oauth");
  return join(root, `${region}.json`);
}
