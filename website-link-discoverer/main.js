import fs from "node:fs";
import path from "node:path";
import { PlaywrightCrawler, EnqueueStrategy, log } from "crawlee";
import { chromium } from "playwright";

const DEFAULT_START_URL = "https://crawlee.dev";
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_OUTPUT_PATH = "sitemap.json";

const startUrl =
  getArg("--url") ||
  getArg("--start-url") ||
  process.env.START_URL ||
  DEFAULT_START_URL;

const maxRequests =
  toNumber(getArg("--max-requests") || process.env.MAX_REQUESTS) || DEFAULT_MAX_REQUESTS;

const maxConcurrency =
  toNumber(getArg("--max-concurrency") || process.env.MAX_CONCURRENCY) || 1;

const navigationTimeoutSecs =
  toNumber(getArg("--navigation-timeout") || process.env.NAVIGATION_TIMEOUT_SECS) || 45;

const requestHandlerTimeoutSecs =
  toNumber(getArg("--request-handler-timeout") || process.env.REQUEST_HANDLER_TIMEOUT_SECS) || 180;

const maxRequestRetries =
  toNumber(getArg("--max-retries") || process.env.MAX_REQUEST_RETRIES) || 1;

const outputPath = getArg("--out") || process.env.OUTPUT_PATH || DEFAULT_OUTPUT_PATH;
const browserChannel = normalizeBrowserChannel(process.env.BROWSER_CHANNEL);

const sensitiveWords = buildSensitiveWords(
  process.env.SENSITIVE_WORDS,
  ["delete", "remove", "pay", "submit", "confirm", "logout", "reset", "clear"]
);

const pagesByUrl = new Map();

const blockedResourceTypes = parseBlockedResources(
  getArg("--block-resources") || process.env.BLOCK_RESOURCE_TYPES,
  ["image", "font", "media"]
);

const launchOptions = { headless: true };
if (browserChannel) {
  launchOptions.channel = browserChannel;
  log.info(`Using browser channel: ${browserChannel}`);
}

// Crawl using a real browser and keep exploration within the same domain.
const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxRequests,
  maxConcurrency,
  maxRequestRetries,
  navigationTimeoutSecs,
  requestHandlerTimeoutSecs,
  launchContext: {
    launcher: browserChannel ? chromium : undefined,
    launchOptions
  },
  preNavigationHooks: [
    async ({ page }, gotoOptions) => {
      await setupRequestFiltering(page, blockedResourceTypes);
      gotoOptions.waitUntil = "domcontentloaded";
    }
  ],
  requestHandler: async ({ request, page, enqueueLinks, log: pageLog }) => {
    pageLog.info(`Processing ${request.url}`);

    await hardenPage(page);
    await waitForNetworkIdle(page);
    await autoScroll(page);
    // Click only safe expanders to reveal hidden links without risky actions.
    await expandPanels(page, sensitiveWords);

    const title = await page.title().catch(() => "");
    const elements = await extractInteractiveElements(page);
    const pageUrl = page.url();

    if (!pagesByUrl.has(pageUrl)) {
      pagesByUrl.set(pageUrl, { url: pageUrl, title, elements });
    }

    await enqueueLinks({
      selector: "a[href]",
      strategy: EnqueueStrategy.SAME_DOMAIN
    });
  },
  failedRequestHandler: ({ request, error }) => {
    log.warning(`Request failed: ${request.url} ${error?.message || ""}`);
  }
});

await crawler.run([startUrl]);

const pages = Array.from(pagesByUrl.values());
const result = {
  startUrl,
  totalPages: pages.length,
  pages
};

fs.writeFileSync(path.resolve(outputPath), JSON.stringify(result, null, 2), "utf-8");
log.info(`Wrote ${outputPath} with ${pages.length} pages`);

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function toNumber(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildSensitiveWords(envValue, defaults) {
  const source = envValue ? envValue.split(",") : defaults;
  return source
    .map((word) => String(word).trim().toLowerCase())
    .filter((word) => word.length > 0);
}

function normalizeBrowserChannel(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "chrome" || normalized === "msedge") return normalized;
  log.warning(`Ignoring unsupported BROWSER_CHANNEL: ${value}`);
  return undefined;
}

function parseBlockedResources(value, defaults) {
  if (!value) return new Set(defaults);
  const normalized = String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set(normalized);
}

async function setupRequestFiltering(page, blockedTypes) {
  if (!blockedTypes || blockedTypes.size === 0) return;

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (blockedTypes.has(type)) return route.abort();
    return route.continue();
  });
}

async function waitForNetworkIdle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const distance = 800;
    const delay = 80;
    const getScrollHeight = () => document.documentElement.scrollHeight;

    for (let y = 0; y < getScrollHeight(); y += distance) {
      window.scrollTo(0, y);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
    window.scrollTo(0, 0);
  });
}

async function expandPanels(page, sensitiveList) {
  const handles = await page.$$('[aria-expanded="false"]');

  for (const handle of handles) {
    const isVisible = await handle.isVisible().catch(() => false);
    if (!isVisible) continue;

    const text = (await handle.innerText().catch(() => "")) || "";
    const aria = (await handle.getAttribute("aria-label")) || "";
    const combined = `${text} ${aria}`.toLowerCase();

    if (sensitiveList.some((w) => combined.includes(w))) continue;

    await handle.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

async function hardenPage(page) {
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => undefined));

  await page
    .evaluate(() => {
      document.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        true
      );
    })
    .catch(() => undefined);
}

async function extractInteractiveElements(page) {
  return page.evaluate(() => {
    const MAX_TEXT_LEN = 80;
    const selectors = [
      "a[href]",
      "button",
      "[role=button]",
      "[onclick]",
      "input[type=submit]",
      "input[type=button]",
      "form[action]"
    ];

    const root = document.documentElement;
    const seen = new Set();
    const out = [];

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      return true;
    }

    function getText(el) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const aria = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const value = el.value || "";
      const candidates = [text, aria, title, placeholder, value].filter(Boolean);
      return (candidates[0] || "").slice(0, MAX_TEXT_LEN);
    }

    function escapeAttrValue(value) {
      const esc = window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape : null;
      if (esc) return esc(value);
      return String(value).replace(/"/g, "\\\"");
    }

    function isUnique(selector) {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    }

    // Prefer stable attributes; fall back to a tag path with :nth-of-type.
    function generateStableSelector(el) {
      if (el.id) {
        const sel = `#${escapeAttrValue(el.id)}`;
        if (isUnique(sel)) return sel;
      }

      const dataAttrs = ["data-testid", "data-test", "data-qa", "data-cy", "data-id"];
      for (const attr of dataAttrs) {
        const val = el.getAttribute(attr);
        if (val) {
          const sel = `[${attr}="${escapeAttrValue(val)}"]`;
          if (isUnique(sel)) return sel;
        }
      }

      const role = el.getAttribute("role");
      const ariaLabel = el.getAttribute("aria-label");
      if (role && ariaLabel) {
        const sel = `[role="${escapeAttrValue(role)}"][aria-label="${escapeAttrValue(ariaLabel)}"]`;
        if (isUnique(sel)) return sel;
      }

      const parts = [];
      let current = el;
      while (current && current !== root && parts.length < 30) {
        const tag = current.tagName.toLowerCase();
        const parentEl = current.parentElement;
        if (!parentEl) break;
        const sameTagSiblings = Array.from(parentEl.children).filter(
          (child) => child.tagName === current.tagName
        );
        const idx = sameTagSiblings.indexOf(current) + 1;
        const part = sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag;
        parts.unshift(part);
        current = parentEl;
      }

      const selector = parts.join(" > ");
      return selector || el.tagName.toLowerCase();
    }

    function getContextPath(el) {
      const labels = [];
      let current = el;
      let hops = 0;

      while (current && hops < 6) {
        const tag = current.tagName ? current.tagName.toLowerCase() : "";
        const role = current.getAttribute ? current.getAttribute("role") || "" : "";
        const aria = current.getAttribute ? current.getAttribute("aria-label") || "" : "";
        const id = current.id || "";
        const className = typeof current.className === "string" ? current.className : "";

        const isNavish =
          tag === "nav" ||
          tag === "aside" ||
          role === "navigation" ||
          className.includes("sidebar") ||
          className.includes("breadcrumb");

        if (isNavish) {
          const label = (aria || id || tag).trim();
          if (label) labels.push(label);
        }

        current = current.parentElement;
        hops += 1;
      }

      return labels.reverse().join(" > ");
    }

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const el of elements) {
        if (!isVisible(el)) continue;

        const tag = el.tagName.toLowerCase();
        let type = "button";
        let href = "";

        if (tag === "a") {
          type = "link";
          href = el.href || "";
        } else if (tag === "form") {
          type = "form";
          href = el.action || "";
        } else {
          type = "button";
        }

        const selectorText = generateStableSelector(el);
        const text = getText(el);
        const context = getContextPath(el);

        const key = `${type}::${href}::${selectorText}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          type,
          text,
          href,
          selector: selectorText,
          context
        });
      }
    }

    return out;
  });
}
