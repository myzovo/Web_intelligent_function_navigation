# Website Link Discoverer

## 简介 / Overview

这是一个基于 **Crawlee + Playwright** 的爬虫：对目标站点进行页面探索，并在每个页面中提取“可交互入口”（链接、按钮、提交按钮、表单提交等），最后输出结构化的 `sitemap.json`。

This is a **Crawlee + Playwright** crawler that explores a website and extracts interactive entry points (links, buttons, submit buttons, form submissions, etc.) from each page, outputting a structured `sitemap.json`.

## 安装 / Install

```bash
npm install
```

安装 Playwright 浏览器（以 Chromium 为例）：

```bash
npx playwright install chromium
```

如果你无法下载浏览器，可改用系统浏览器（Chrome/Edge），例如：

If you cannot download Playwright browsers, you can use a system-installed browser instead (Chrome/Edge), for example:

```bash
BROWSER_CHANNEL=msedge node main.js --url https://crawlee.dev
```

如果网络较慢，可先切换 npm 镜像：

If your network is slow, you can switch npm registry first:

```bash
npm config set registry https://registry.npmmirror.com
```

## 快速开始（CLI）/ Quick Start (CLI)

1. 最简单运行（抓取少量页面快速验证）：

Run with a small crawl to verify:

```bash
node main.js --url https://crawlee.dev --max-requests 10 --out sitemap.json
```

2. 限制资源 / 降低带宽（默认会阻断 `image,font,media`）：

Block heavy resources to reduce bandwidth (default: `image,font,media`):

```bash
node main.js --url https://crawlee.dev --block-resources image,font,media
```

3. 降低并发（内存不足时）：

Lower concurrency if you hit memory limits:

```bash
node main.js --url https://crawlee.dev --max-requests 100 --max-concurrency 1
```

4. 超时调整（页面加载/渲染慢时）：

Adjust timeouts if pages are slow:

```bash
node main.js --url https://crawlee.dev --navigation-timeout 60 --request-handler-timeout 240
```

## 关键参数 / Key Parameters

`main.js` 支持 CLI 参数与环境变量（环境变量优先级更低，CLI 有值会覆盖）。

`main.js` supports CLI args and environment variables (CLI values override env vars).

### 必填 / Start

- `--url` / `--start-url` / `START_URL`：起始 URL
  - `--url` / `--start-url` / `START_URL`: start URL

### 输出 / Output

- `--out` / `OUTPUT_PATH`：输出文件名（默认 `sitemap.json`）
  - `--out` / `OUTPUT_PATH`: output file (default: `sitemap.json`)

### 抓取边界 / Crawl Boundaries

- `--max-requests` / `MAX_REQUESTS`：最大抓取页面数
  - `--max-requests` / `MAX_REQUESTS`: max pages
- `--max-concurrency` / `MAX_CONCURRENCY`：并发数
  - `--max-concurrency` / `MAX_CONCURRENCY`: concurrency
- `--allowed-domains` / `ALLOWED_DOMAINS`：允许的站点域名（逗号分隔）
  - `--allowed-domains` / `ALLOWED_DOMAINS`: allowed domains (comma-separated)
  - 不传时，默认只允许 `startUrl` 的主域名（同域为主）
  - If not provided, it defaults to the start URL hostname only.

### 渲染等待与重试 / Timing & Retries

- `--navigation-timeout` / `NAVIGATION_TIMEOUT_SECS`：导航超时（秒，默认 45）
  - `--navigation-timeout` / `NAVIGATION_TIMEOUT_SECS`: navigation timeout (seconds, default 45)
- `--request-handler-timeout` / `REQUEST_HANDLER_TIMEOUT_SECS`：每页 handler 超时（秒，默认 180）
  - `--request-handler-timeout` / `REQUEST_HANDLER_TIMEOUT_SECS`: handler timeout (seconds, default 180)
- `--max-retries` / `MAX_REQUEST_RETRIES`：最大重试次数
  - `--max-retries` / `MAX_REQUEST_RETRIES`: max retries

### 危险操作过滤（安全词）/ Safety Filter

- `SENSITIVE_WORDS`：危险词列表（逗号分隔），用于跳过可能有风险的交互
  - `SENSITIVE_WORDS`: comma-separated dangerous words to skip risky interactions

默认包含中英文危险词：`delete/remove/pay/submit/confirm/logout/reset/clear` 以及 `删除/注销/支付/清空/重置`。
Default includes both English and Chinese words:
`delete/remove/pay/submit/confirm/logout/reset/clear` and `删除/注销/支付/清空/重置`.

### 浏览器 / Browser

- `--browser-channel` / `BROWSER_CHANNEL`：`chrome` 或 `msedge`
  - `--browser-channel` / `BROWSER_CHANNEL`: `chrome` or `msedge`

### 带宽/资源控制 / Bandwidth / Resource Control

- `--block-resources` / `BLOCK_RESOURCE_TYPES`：要拦截的资源类型（逗号分隔，默认 `image,font,media`）
  - `--block-resources` / `BLOCK_RESOURCE_TYPES`: resource types to block (comma-separated, default: `image,font,media`)

## 输出格式 / Output Format

爬虫会写出 `sitemap.json`，结构如下：

The crawler writes `sitemap.json` in this format:

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
          "href": "https://example.com/leave/apply",
          "selector": "#nav > li:nth-child(2) > a",
          "context": "sidebar > hr"
        }
      ]
    }
  ]
}
```

`elements[]` 字段说明：

`elements[]` fields:

- `type`：元素类型（可能包含 `link`, `button`, `submit`, `form`, `menuitem`, `onclick`, `role-link` 等）
  - `type`: element type (e.g. `link`, `button`, `submit`, `form`, `menuitem`, `onclick`, `role-link`)
- `text`：元素可读文本（含部分 `aria-label/title/placeholder/value`）
  - `text`: readable text (derived from `innerText` plus aria/title/placeholder/value)
- `href`：链接地址（非链接/表单提交流域内的元素可能为空）
  - `href`: resolved URL for links/forms (can be empty for non-link elements)
- `selector`：稳定选择器字符串（用于前端定位/高亮）
  - `selector`: stable CSS selector string
- `context`：语义容器上下文（例如侧边栏/面包屑/菜单层级）
  - `context`: semantic container context (nav/sidebar/breadcrumb/menu hierarchy)

## 使用 Web 界面（server.js）/ Use Web UI (server.js)

如果你想通过浏览器可视化启动/查看结果：

If you prefer a browser UI to start crawls and inspect results:

1. 启动服务：

Start the server:

```bash
npm run server
```

2. 打开：

Open:

`http://localhost:3456`

3. 在页面里填写以下字段并点击开始：

Fill these fields in the UI and click “Start”:

- URL：起始 URL
  - URL: start URL
- Max Requests：最大页面数
  - Max Requests: max pages
- Max Concurrency：并发数
  - Max Concurrency: concurrency
- Navigation Timeout：页面导航超时（秒）
  - Navigation Timeout: navigation timeout (seconds)
- Request Handler Timeout：每页 handler 超时（秒）
  - Request Handler Timeout: handler timeout (seconds)
- Browser Channel：`chrome` 或 `msedge`
  - Browser Channel: `chrome` or `msedge`
- Blocked Resources：阻断资源类型（默认 `image,font,media`）
  - Blocked Resources: blocked resource types (default `image,font,media`)
- Sensitive Words：危险词列表（逗号分隔）
  - Sensitive Words: comma-separated dangerous words
- Max Retries：最大重试次数
  - Max Retries: max retries

结果文件会保存在 `website-link-discoverer/outputs/` 目录中。
Output files are saved under `website-link-discoverer/outputs/`.

停止按钮会调用 `/api/crawl/stop`。
The stop button calls `/api/crawl/stop`.

## 故障排查 / Troubleshooting

- 报错 “Failed to launch browser / executable doesn't exist”：
  1. 先运行 `npx playwright install chromium`（或你要用的浏览器通道）
  2. 或设置 `BROWSER_CHANNEL=msedge|chrome` 使用系统浏览器
  - Error about missing browser executable:
    1. Run `npx playwright install chromium` (or the browser you need)
    2. Or set `BROWSER_CHANNEL=msedge|chrome` to use a system browser

- 输出没有 elements：
  - 先确认抓取成功（日志里是否 `Processing ...` 后面有成功）
  - 可尝试增加 `--max-requests` 或适当增大超时
  - If there are no `elements`:
    - confirm requests succeed in logs
    - increase `--max-requests` or timeouts
