# User Guide (Web Intelligent Function Navigation)

这份文档面向非技术用户，按步骤说明如何启动与使用前端控制台。

## 1. 准备环境

在首次使用前执行一次：

```bash
cd website-link-discoverer
npm install
npx playwright install chromium
```

如果无法下载浏览器，可使用系统浏览器：

```bash
set BROWSER_CHANNEL=msedge
```

## 2. 启动服务

在 `website-link-discoverer` 目录中执行：

```bash
npm run server
```

浏览器打开：

```
http://localhost:3456
```

## 3. 开始爬取

1. 在“目标网址”输入要扫描的网站。
2. 点击“开始爬取”。
3. 观察“实时日志”和状态指示灯。
4. 结束后可在结果区查看概览/列表。

## 4. 打开报告页

在控制台的“数据库爬取索引”区域：

- 点击“打开最新报告”查看刚完成的结果（从服务器同步）。
- 点击列表中的“查看报告”打开历史 JSON。

## 5. 结果文件位置

- Web 控制台运行的结果默认保存在：
  - `website-link-discoverer/outputs/`
- 数据库索引扫描的是：
  - `website-link-discoverer/database/`

如果你用 CLI 运行并输出到 database 目录，这些文件会出现在索引里。

## 6. 常见问题

### 启动报错 EACCES: permission denied 0.0.0.0:3000（或 3456）

端口被占用。解决方法：

1. 换一个端口启动：

   ```bash
   set PORT=4567
   npm run server
   ```

   然后访问 `http://localhost:4567`。

2. 或者先关闭占用端口的程序，再重新启动。

### 不能爬取或没有结果

请按顺序排查：

1. 服务是否启动：终端里是否仍在运行 `npm run server`。
2. 浏览器是否安装：执行过 `npx playwright install chromium`。
3. URL 是否正确：必须是完整网址，例如 `https://example.com`。
4. 网络是否可达：公司内网或被防火墙拦截会导致失败。
5. 查看“实时日志”，是否有报错提示。

### 报告页无数据显示

1. 如果是“最新报告”，确认刚完成一次爬取且服务未重启。
2. 如果是“历史文件”，确认 JSON 文件确实存在于 `database/`。

---

如需进一步排查，请把日志内容截图或复制给维护人员。
