# Website Link Discoverer

A Crawlee + Playwright crawler that discovers interactive entry points (links, buttons, forms) and outputs a structured sitemap JSON.

## Install

```bash
npm install
```

Install Playwright Chromium:

```bash
npx playwright install chromium
```

If you cannot download Playwright browsers, you can use a system-installed browser instead:

```bash
BROWSER_CHANNEL=msedge node main.js --url https://crawlee.dev
```

If your network is slow, you can switch to the npm mirror first:

```bash
npm config set registry https://registry.npmmirror.com
```

## Run

```bash
node main.js --url https://crawlee.dev --max-requests 100 --out sitemap.json
```

If you run into memory pressure, lower concurrency:

```bash
node main.js --url https://crawlee.dev --max-requests 100 --max-concurrency 1
```

If pages time out, adjust navigation and handler timeouts:

```bash
node main.js --url https://crawlee.dev --navigation-timeout 60 --request-handler-timeout 240
```

To reduce bandwidth, block heavy resources (default: image,font,media):

```bash
node main.js --url https://crawlee.dev --block-resources image,font,media
```

You can also use environment variables:

- `START_URL`
- `MAX_REQUESTS`
- `OUTPUT_PATH`
- `SENSITIVE_WORDS` (comma-separated, used to skip dangerous clicks)
- `BROWSER_CHANNEL` (`chrome` or `msedge`)
- `MAX_CONCURRENCY`
- `NAVIGATION_TIMEOUT_SECS`
- `REQUEST_HANDLER_TIMEOUT_SECS`
- `MAX_REQUEST_RETRIES`
- `BLOCK_RESOURCE_TYPES` (comma-separated)

Example:

```bash
START_URL=https://crawlee.dev MAX_REQUESTS=100 node main.js
```

## Output format

The crawler writes `sitemap.json` using this structure:

```json
{
  "startUrl": "...",
  "totalPages": 15,
  "pages": [
    {
      "url": "...",
      "title": "...",
      "elements": [
        {
          "type": "link",
          "text": "Leave request",
          "href": "/leave/apply",
          "selector": "#nav > li:nth-child(2) > a",
          "context": "sidebar > hr"
        }
      ]
    }
  ]
}
```

## Sample log (example)

```text
Processing https://crawlee.dev/
Processing https://crawlee.dev/docs
Processing https://crawlee.dev/docs/quick-start
Wrote sitemap.json with 42 pages
```

## Notes

- Same-domain restriction is enforced via `enqueueLinks({ strategy: EnqueueStrategy.SAME_DOMAIN })`.
- The crawler waits for `networkidle`, scrolls to the bottom, and safely clicks `[aria-expanded="false"]`.
- To add locale-specific safety words, extend `SENSITIVE_WORDS` (comma-separated).
