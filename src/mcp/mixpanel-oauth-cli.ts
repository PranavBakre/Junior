import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  MIXPANEL_OAUTH_CALLBACK_PORT,
  MixpanelOAuthProvider,
} from "./mixpanel-oauth.ts";
import { mixpanelRegionUrl, type MixpanelRegion } from "./mixpanel-proxy.ts";

const ALL_REGIONS: MixpanelRegion[] = ["us", "eu", "in"];
const requested = process.argv.slice(2).map((value) => value.toLowerCase());
const invalid = requested.filter((value) => !ALL_REGIONS.includes(value as MixpanelRegion));
if (invalid.length > 0) throw new Error(`Unknown Mixpanel region(s): ${invalid.join(", ")}`);
const REGIONS = requested.length > 0 ? requested as MixpanelRegion[] : ALL_REGIONS;

for (const region of REGIONS) await authorize(region);
console.log(`Mixpanel OAuth connected for ${REGIONS.map((region) => region.toUpperCase()).join(", ")}.`);

async function authorize(region: MixpanelRegion): Promise<void> {
  let callbackPromise: Promise<string> | null = null;
  const provider = await MixpanelOAuthProvider.create(region, async (url) => {
    callbackPromise = waitForCallback(provider.expectedState());
    console.log(`\nAuthorize Mixpanel ${region.toUpperCase()}:\n${url}`);
    await openBrowser(url);
  });
  const client = new Client({ name: `junior-mixpanel-oauth-${region}`, version: "0.1.0" });
  let transport = new StreamableHTTPClientTransport(new URL(mixpanelRegionUrl(region)), {
    authProvider: provider,
  });
  try {
    await client.connect(transport);
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !callbackPromise) throw err;
    const code = await callbackPromise;
    await transport.finishAuth(code);
    transport = new StreamableHTTPClientTransport(new URL(mixpanelRegionUrl(region)), {
      authProvider: provider,
    });
    await client.connect(transport);
  }
  await client.listTools();
  await client.close();
  console.log(`Connected ${region.toUpperCase()}.`);
}

function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error || !code || state !== expectedState) {
        const reason = error
          ? `${error}${errorDescription ? `: ${errorDescription}` : ""}`
          : !code
            ? "authorization code was missing"
            : "OAuth state did not match";
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`Mixpanel authorization failed: ${reason}. Return to the terminal.`);
        server.close();
        reject(new Error(`Mixpanel OAuth callback failed: ${reason}`));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Mixpanel connected</h1><p>You can close this tab.</p>");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(MIXPANEL_OAUTH_CALLBACK_PORT, "127.0.0.1");
  });
}

async function openBrowser(url: URL): Promise<void> {
  const platform = process.platform;
  const command = platform === "darwin"
    ? ["open", url.toString()]
    : platform === "win32"
      ? ["cmd", "/c", "start", "", url.toString()]
      : ["xdg-open", url.toString()];
  try {
    await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // The printed URL remains usable on headless systems.
  }
}
