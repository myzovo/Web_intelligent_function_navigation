import fs from "node:fs";
import path from "node:path";
import { PlaywrightCrawler, EnqueueStrategy, log } from "crawlee";
import { chromium } from "playwright";

const DEFAULT_START_URL = "https://crawlee.dev";
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_OUTPUT_PATH = "sitemap.json";
const DEFAULT_DATABASE_PATH = path.resolve("..", "database", "sitemap.json");

const startUrl =
  getArg("--url") ||
  getArg("--start-url") ||
  process.env.START_URL ||
  DEFAULT_START_URL;

const startHostname = safeHostname(startUrl);
const allowedDomains = buildAllowedDomains(
  getArg("--allowed-domains") || process.env.ALLOWED_DOMAINS,
  startHostname ? [startHostname] : []
);

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

const outputPathArg = getArg("--out") || process.env.OUTPUT_PATH;
const databasePath = resolveDatabasePath(
  getArg("--database-path") || process.env.DATABASE_PATH || outputPathArg || DEFAULT_DATABASE_PATH
);
const outputPath = outputPathArg || DEFAULT_OUTPUT_PATH;
const browserChannel = normalizeBrowserChannel(getArg("--browser-channel") || process.env.BROWSER_CHANNEL);

const sensitiveWords = buildSensitiveWords(
  process.env.SENSITIVE_WORDS,
  [
    // English
    "delete",
    "remove",
    "pay",
    "submit",
    "confirm",
    "logout",
    "reset",
    "clear",
    // Chinese (per Plan.md)
    "删除",
    "注销",
    "支付",
    "清空",
    "重置"
  ]
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
    const elements = await extractInteractiveElements(page, allowedDomains, sensitiveWords);
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

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(databasePath, JSON.stringify(result, null, 2), "utf-8");
log.info(`Wrote ${databasePath} with ${pages.length} pages`);

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

function resolveDatabasePath(value) {
  const candidate = String(value || DEFAULT_DATABASE_PATH).trim();
  if (path.isAbsolute(candidate)) {
    return candidate;
  }

  return path.resolve(candidate);
}

function buildSensitiveWords(envValue, defaults) {
  const source = envValue ? envValue.split(",") : defaults;
  return source
    .map((word) => String(word).trim().toLowerCase())
    .filter((word) => word.length > 0);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function buildAllowedDomains(envValue, defaults) {
  const source = envValue
    ? String(envValue)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : defaults;

  // Normalize domains for matching (e.g. strip leading "www.").
  return (source || []).map((d) => String(d).toLowerCase().replace(/^www\./, ""));
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

async function extractInteractiveElements(page, allowedDomains, sensitiveWords) {
  return page.evaluate((payload) => {
    const allowedDomainsArg = payload.allowedDomains;
    const sensitiveWordsArg = payload.sensitiveWords;
    const MAX_TEXT_LEN = 80;
    const hasAllowedDomains = Array.isArray(allowedDomainsArg) && allowedDomainsArg.length > 0;
    const normalizedAllowedDomains = hasAllowedDomains
      ? allowedDomainsArg.map((d) => String(d).toLowerCase().replace(/^www\./, ""))
      : [];

    const selectors = [
      "a[href]",
      "button",
      "[role=button]",
      "[role=link]",
      "[role=menuitem]",
      "[onclick]",
      "input[type=submit]",
      "button[type=submit]",
      "input[type=button]",
      "form[action]"
    ];

    const root = document.documentElement;
    const seen = new Set();
    const out = [];

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
      if (el.offsetParent === null && !["fixed", "sticky"].includes(style.position)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      return true;
    }

    function normalizeHost(hostname) {
      return String(hostname || "").toLowerCase().replace(/^www\./, "");
    }

    function isAllowedHostname(hostname) {
      if (!hasAllowedDomains) return true;
      const host = normalizeHost(hostname);
      return normalizedAllowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
    }

    function isDangerousText(text) {
      if (!Array.isArray(sensitiveWordsArg) || sensitiveWordsArg.length === 0) return false;
      const safetyText = String(text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      return sensitiveWordsArg.some((w) => safetyText.includes(w));
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

    function getSafetyText(el) {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const aria = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const value = el.value || "";
      const candidates = [text, aria, title, placeholder, value].filter(Boolean);
      return candidates.join(" ").trim();
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

    function getKeyClasses(el) {
      try {
        const classes = Array.from(el.classList || []).map((c) => String(c).trim()).filter(Boolean);
        const blacklist = new Set([
          // Common UI utility words that often appear everywhere (less stable).
          "btn",
          "button",
          "link",
          "nav",
          "menu",
          "sidebar",
          "breadcrumb",
          "active"
        ]);
        return classes
          .filter((c) => c.length >= 3)
          .filter((c) => !blacklist.has(c.toLowerCase()))
          .slice(0, 2);
      } catch {
        return [];
      }
    }

    function buildPathParts(el, maxHops = 8) {
      const parts = [];
      let current = el;
      let hops = 0;

      while (current && current !== root && hops < maxHops) {
        if (!current.tagName) break;
        const tag = current.tagName.toLowerCase();
        const classes = getKeyClasses(current);
        const classPart = classes.length ? `.${classes.join(".")}` : "";
        parts.unshift(`${tag}${classPart}`);
        current = current.parentElement;
        hops += 1;
      }

      return parts;
    }

    function pickShortestUniquePath(el) {
      const parts = buildPathParts(el);
      if (!parts.length) return el.tagName.toLowerCase();

      // Try shortest selectors first: suffix from element upward.
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const candidate = parts.slice(i).join(" > ");
        if (isUnique(candidate)) return candidate;
      }

      return parts.join(" > ");
    }

    // Prefer stable attributes; fall back to a compact tag+class path.
    function generateStableSelector(el) {
      if (el.id) {
        const sel = `#${escapeAttrValue(el.id)}`;
        return sel;
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
      const ariaLabelledBy = el.getAttribute("aria-labelledby");

      if (ariaLabel) {
        const sel = `[aria-label="${escapeAttrValue(ariaLabel)}"]`;
        return sel;
      }

      if (ariaLabelledBy) {
        const sel = `[aria-labelledby="${escapeAttrValue(ariaLabelledBy)}"]`;
        return sel;
      }

      if (role && ariaLabel) {
        const sel = `[role="${escapeAttrValue(role)}"][aria-label="${escapeAttrValue(ariaLabel)}"]`;
        return sel;
      }

      return pickShortestUniquePath(el);
    }

    function extractContainerLabel(container) {
      try {
        const aria = container.getAttribute && container.getAttribute("aria-label");
        if (aria) return String(aria).trim().slice(0, 80);

        const title = container.getAttribute && container.getAttribute("title");
        if (title) return String(title).trim().slice(0, 80);

        const heading =
          container.querySelector &&
          container.querySelector("h1,h2,h3,h4,h5,h6,[role='heading'],.section-title,.section-header");
        if (heading) {
          const text = (heading.innerText || heading.textContent || "").replace(/\s+/g, " ").trim();
          if (text) return text.slice(0, 80);
        }

        const link = container.querySelector && container.querySelector("a[href], button, [role='link']");
        if (link) {
          const text = (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim();
          if (text) return text.slice(0, 80);
        }

        const id = container.id;
        if (id) return String(id).trim().slice(0, 80);

        const className = typeof container.className === "string" ? container.className : "";
        const firstClass = className.split(/\s+/).filter(Boolean)[0];
        if (firstClass) return firstClass.trim().slice(0, 80);
      } catch {
        // ignore
      }
      return "";
    }

    function getContextPath(el) {
      const labels = [];
      let current = el;
      let hops = 0;

      while (current && hops < 8) {
        if (current && current.nodeType === 1) {
          const tag = current.tagName ? current.tagName.toLowerCase() : "";
          const role = current.getAttribute ? current.getAttribute("role") || "" : "";
          const className = typeof current.className === "string" ? current.className : "";

          const isNavish =
            tag === "nav" ||
            tag === "aside" ||
            role === "navigation" ||
            tag === "ul" && className.includes("menu") ||
            role === "menu" ||
            className.includes("sidebar") ||
            className.includes("breadcrumb") ||
            (current.matches && current.matches("ul.menu,[role='menu']"));

          if (isNavish) {
            const label = extractContainerLabel(current);
            if (label && (!labels.length || labels[labels.length - 1] !== label)) labels.push(label);
          }
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

        // Skip dangerous/unrelated elements early (we are not going to click them, but they pollute the map).
        if (isDangerousText(getSafetyText(el))) continue;

        const tag = (el.tagName || "").toLowerCase();
        const role = el.getAttribute ? el.getAttribute("role") : "";
        let type = "button";
        let href = "";

        if (tag === "a") {
          type = "link";
          href = el.href || "";
        } else if (tag === "form") {
          type = "form";
          href = el.action || "";
        } else if (tag === "input" && el.type === "submit") {
          type = "submit";
        } else if (tag === "button" && el.type === "submit") {
          type = "submit";
        } else if (role === "menuitem") {
          type = "menuitem";
        } else if (role === "link") {
          type = "role-link";
        } else if (el.hasAttribute && el.hasAttribute("onclick")) {
          type = "onclick";
        } else {
          type = "button";
        }

        if (href) {
          try {
            const u = new URL(href, document.baseURI);
            if (!["http:", "https:"].includes(u.protocol)) continue;
            if (!isAllowedHostname(u.hostname)) continue;
            href = u.href;
          } catch {
            // Ignore invalid URLs (keep as-is only if we can't parse).
          }
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
  }, { allowedDomains, sensitiveWords });
}
