// Diljit Dosanjh ticket-drop watcher.
// Polls tour pages, alerts via Telegram (+ macOS notification/browser) the moment
// a ticketing link or on-sale wording appears. Zero dependencies, Node >= 20.6.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------- config ----------
const env = process.env;
const WATCH_URLS = (env.WATCH_URLS ?? "https://www.diljitdosanjh.com/tour/ahmedabad/")
  .split(",").map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Number(env.INTERVAL_SECONDS ?? 15) * 1000;
const HEARTBEAT_MS = Number(env.HEARTBEAT_HOURS ?? 0) * 3600 * 1000;
const OPEN_BROWSER = env.OPEN_BROWSER !== "0";
const SPEAK = env.SPEAK !== "0";
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = env.TELEGRAM_CHAT_ID;
const STATE_PATH = env.STATE_FILE ?? "state/state.json";
const STATE_FILE = new URL(`./${STATE_PATH}`, import.meta.url);
const IS_CI = env.CI === "true" || env.GITHUB_ACTIONS === "true";

const ONCE = process.argv.includes("--once");
const TEST_ALERT = process.argv.includes("--test-alert");

// Known ticketing platforms. Any href on these hosts = drop is live.
const TICKET_HOSTS = /(bookmyshow|district\.in|zomato\.com\/live|zomato\.com\/events|insider\.in|paytm\.com|paytminsider|ticketmaster|ticketgenie|skillboxes|tixr|eventbrite|kyazoonga|ticketek|axs\.com|dice\.fm|ticketsforgood|ticketkhidki|bigtree)/i;
// Wording that signals sale opened. "Register" / "Count me in" = pre-sale state.
const ON_SALE_WORDS = /\b(buy tickets?|get tickets?|book now|book tickets?|tickets? (are )?(now )?(on sale|available|live)|on sale now|purchase tickets?)\b/i;
const PRE_SALE_WORDS = /\b(count me in|register (your )?interest|fan registration)\b/i;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); }
  catch { return { pages: {}, lastHeartbeat: 0 }; }
}
async function saveState(s) {
  await mkdir(new URL(".", STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

function extract(html, base) {
  // Strip scripts/styles so Next.js build hashes and nonces don't churn the fingerprint.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  const main = stripped.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? stripped;

  const hrefs = new Set();
  for (const m of main.matchAll(/href=["']([^"']+)["']/gi)) {
    try { hrefs.add(new URL(m[1], base).href); } catch { /* ignore bad href */ }
  }
  const ticketLinks = [...hrefs].filter((h) => TICKET_HOSTS.test(h));

  const text = main.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const onSale = ON_SALE_WORDS.test(text);
  const preSale = PRE_SALE_WORDS.test(text);

  // Cheap fingerprint of visible text: catches any content change as a fallback signal.
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;

  return { ticketLinks, onSale, preSale, hash: String(hash), textSample: text.slice(0, 200) };
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, "cache-control": "no-cache", pragma: "no-cache", accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- alerting ----------
async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) { log("telegram not configured, skipping"); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: false }),
  });
  if (!res.ok) log("telegram error", res.status, await res.text());
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, () => resolve()));
}

async function localAlert(title, body, openUrl) {
  if (process.platform !== "darwin" || IS_CI) return;
  const esc = (s) => s.replace(/["\\]/g, "\\$&");
  await run("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`]);
  if (SPEAK) run("say", ["-r", "200", "Diljit tickets are live. Go go go."]);
  if (OPEN_BROWSER && openUrl) run("open", [openUrl]);
}

async function alert({ url, reason, ticketLinks }) {
  const lines = [
    "🚨 DILJIT TICKETS — CHANGE DETECTED",
    `Reason: ${reason}`,
    `Page: ${url}`,
    ...(ticketLinks.length ? ["", "Ticket links:", ...ticketLinks] : []),
  ];
  const msg = lines.join("\n");
  log(msg);
  await Promise.all([
    telegram(msg),
    localAlert("Diljit tickets", reason, ticketLinks[0] ?? url),
  ]);
}

// ---------- core ----------
async function checkUrl(url, state) {
  const html = await fetchPage(url);
  const now = extract(html, url);
  const prev = state.pages[url];

  if (!prev) {
    state.pages[url] = now;
    log(`baseline ${url}: links=${now.ticketLinks.length} onSale=${now.onSale} preSale=${now.preSale}`);
    if (now.ticketLinks.length || now.onSale) {
      await alert({ url, reason: "ticket link/on-sale wording present at first check", ticketLinks: now.ticketLinks });
    }
    return;
  }

  const newLinks = now.ticketLinks.filter((l) => !prev.ticketLinks.includes(l));
  const reasons = [];
  if (newLinks.length) reasons.push(`new ticket link(s): ${newLinks.length}`);
  if (now.onSale && !prev.onSale) reasons.push("on-sale wording appeared");
  if (prev.preSale && !now.preSale) reasons.push("registration wording removed");
  if (now.hash !== prev.hash && !reasons.length) reasons.push("page content changed (unclassified)");

  state.pages[url] = now;

  if (reasons.length) {
    await alert({ url, reason: reasons.join("; "), ticketLinks: now.ticketLinks });
  } else {
    log(`no change ${url}`);
  }
}

async function tick(state) {
  let failures = 0;
  for (const url of WATCH_URLS) {
    try { await checkUrl(url, state); }
    catch (e) { failures++; log(`fetch failed ${url}: ${e.message}`); }
  }
  if (HEARTBEAT_MS && Date.now() - (state.lastHeartbeat ?? 0) > HEARTBEAT_MS) {
    state.lastHeartbeat = Date.now();
    await telegram(`💓 diljitbot alive. Watching ${WATCH_URLS.length} page(s) every ${INTERVAL_MS / 1000}s.`);
  }
  await saveState(state);
  if (failures === WATCH_URLS.length) {
    throw new Error(`all ${failures} watched page(s) failed to fetch`);
  }
}

async function main() {
  if (TEST_ALERT) {
    await alert({ url: WATCH_URLS[0], reason: "TEST ALERT — ignore", ticketLinks: ["https://in.bookmyshow.com/"] });
    return;
  }
  const state = await loadState();
  log(`watching ${WATCH_URLS.join(", ")} every ~${INTERVAL_MS / 1000}s`);
  if (ONCE) { await tick(state); return; }
  for (;;) {
    await tick(state);
    const jitter = INTERVAL_MS * (0.8 + Math.random() * 0.4);
    await sleep(jitter);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
