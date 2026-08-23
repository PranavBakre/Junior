import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { chromium } from "playwright";

const chromeRoot = `${process.env.HOME}/Library/Application Support/Google/Chrome`;
const cookiesPath = `${chromeRoot}/Profile 1/Cookies`;

const secretProcess = Bun.spawnSync([
  "security",
  "find-generic-password",
  "-w",
  "-s",
  "Chrome Safe Storage",
]);

if (secretProcess.exitCode !== 0) {
  throw new Error("Could not access Chrome Safe Storage");
}

const safeStoragePassword = secretProcess.stdout.toString().trim();
const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
const iv = Buffer.alloc(16, 0x20);

function decryptCookie(encryptedValue) {
  const encrypted = Buffer.from(encryptedValue);
  const version = encrypted.subarray(0, 3).toString();
  if (version !== "v10" && version !== "v11") {
    throw new Error(`Unsupported Chrome cookie version: ${version}`);
  }

  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]);

  // Modern Chrome prepends SHA-256(host_key) to the decrypted cookie value.
  return decrypted.subarray(32).toString();
}

const cookieDb = new Database(cookiesPath, { readonly: true });
const storedCookies = cookieDb
  .query(`
    SELECT host_key, name, path, expires_utc, is_secure, is_httponly,
           encrypted_value
    FROM cookies
    WHERE host_key = '.growthx.club'
      AND name IN ('userToken', 'userIsLoggedIn')
  `)
  .all();
cookieDb.close();

const browserCookies = storedCookies.map((cookie) => ({
  name: cookie.name,
  value: decryptCookie(cookie.encrypted_value),
  domain: cookie.host_key,
  path: cookie.path,
  secure: Boolean(cookie.is_secure),
  httpOnly: Boolean(cookie.is_httponly),
  sameSite: "Lax",
}));

const videos = [
  {
    id: "6960e0660a04c67ceec1e8e6",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "Breakdown of The Whole Truth's growth strategy",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/breakdown_of_the_whole_truth_s_growth_strategy_5o0te/breakdown_of_the_whole_truth_s_growth_strategy_5o0te-1a3141d301/breakdown_of_the_whole_truth_s_growth_strategy_5o0te-1a3141d301.mp4",
  },
  {
    id: "66cf68271cd42a8bf63dd8ca",
    productId: "667a955c03bbe5836b8d64db",
    category: "Crafts",
    name: "Nailing the Job Description",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/krishna_kedia_f07d227284/2e4badf371-building_growth_teams_dvqfs_nailing_the_job_description_ioxnj_nailing_the_job_description_ioxnj_02._Number_of_clicks_Part_3.mp4",
  },
  {
    id: "675f5d74f683f304f86cc86b",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "How to launch in the US market for B2B",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/launching_in_the_us_9wte5/launching_in_the_us_9wte5-6372b3d919/launching_in_the_us_9wte5-6372b3d919.mp4",
  },
  {
    id: "696147fb0a04c67ceec3f2b6",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "Breakdown of ET Money's growth strategy",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/breakdown_of_et_money_s_growth_strategy_9ekvw/breakdown_of_et_money_s_growth_strategy_9ekvw-8d5dc0174c/breakdown_of_et_money_s_growth_strategy_9ekvw-8d5dc0174c.mp4",
  },
  {
    id: "675a8a9dbed37f4a42a6f5fb",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "Building Offline Strategy for D2C",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/building_offline_strategy_for_d2c_55022/building_offline_strategy_for_d2c_55022-cb6ff31d7d/building_offline_strategy_for_d2c_55022-cb6ff31d7d.mp4",
  },
  {
    id: "6720e85b597301042cd51f35",
    productId: "64e373f80e8cd1d7844c0b28",
    category: "Other member-only videos",
    name: "What to consider beyond base salary",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/elevate/salary_is_more_than_just_base_pay__negotiate_smart__gnf2g/salary_is_more_than_just_base_pay__negotiate_smart__gnf2g-204abdc196/salary_is_more_than_just_base_pay__negotiate_smart__gnf2g-204abdc196.mp4",
  },
  {
    id: "675b3a50fd8a2c2d57f72a56",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "Selling $1M+ Enterprise Deals in the US",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/selling__1m__enterprise_deals_in_the_us_9hql2/selling__1m__enterprise_deals_in_the_us_9hql2-af7b47d822/selling__1m__enterprise_deals_in_the_us_9hql2-af7b47d822.mp4",
  },
  {
    id: "675b31ed439b9ccfd5bb9538",
    productId: "66a75a16a1e042cecaa8b80f",
    category: "Deep dives (resources)",
    name: "Quick Commerce for D2C Brands",
    url: "https://private-cdn.growthx.club/learning-experience-products/production/resource-directory/quick_commerce_for_d2c_brands_cfllm/quick_commerce_for_d2c_brands_cfllm-2689b81b8c/quick_commerce_for_d2c_brands_cfllm-2689b81b8c.mp4",
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext();
await context.addCookies(browserCookies);

const results = [];
for (const video of videos) {
  const entitlementResponse = await context.request.get(
    `https://backend.growthx.club/api/v1/members/products/${video.productId}/${video.id}`,
    {
      failOnStatusCode: false,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      },
    },
  );
  const entitlement = entitlementResponse.ok()
    ? await entitlementResponse.json()
    : null;
  const playbackId = entitlement?.module?.mux_playback_id;
  const playbackToken = entitlement?.module?.mux_tokens?.playback;
  const browserUrl =
    playbackId && playbackToken
      ? `https://stream.mux.com/${playbackId}.m3u8?token=${encodeURIComponent(playbackToken)}`
      : video.url;
  const page = await context.newPage();
  await page.setContent('<video id="video" preload="metadata"></video>');
  if (playbackId && playbackToken) {
    await page.addScriptTag({
      url: "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js",
    });
  }
  const metadata = await page.evaluate(async ({ url, useHls }) => {
    const media = document.querySelector("#video");
    return await new Promise((resolve) => {
      const timeout = setTimeout(
        () => resolve({ ok: false, error: "metadata timeout" }),
        45_000,
      );
      media.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timeout);
          resolve({ ok: Number.isFinite(media.duration), duration: media.duration });
        },
        { once: true },
      );
      media.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          resolve({
            ok: false,
            error: media.error?.message || "media error",
            code: media.error?.code,
          });
        },
        { once: true },
      );
      if (useHls) {
        const hls = new window.Hls();
        hls.on(window.Hls.Events.LEVEL_LOADED, (_event, data) => {
          clearTimeout(timeout);
          resolve({
            ok: Number.isFinite(data.details.totalduration),
            duration: data.details.totalduration,
          });
          hls.destroy();
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            clearTimeout(timeout);
            resolve({ ok: false, error: data.details, fatal: true });
          }
        });
        hls.loadSource(url);
      } else {
        media.src = url;
        media.load();
      }
    });
  }, { url: browserUrl, useHls: Boolean(playbackId && playbackToken) });
  results.push({
    ...video,
    entitlementStatus: entitlementResponse.status(),
    metadataSource: playbackId && playbackToken ? "signed Mux HLS" : "original MP4",
    ...metadata,
  });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
