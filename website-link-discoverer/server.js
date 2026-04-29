import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join, resolve, sep } from "path";
import { exec } from "child_process";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

let currentProcess = null;
let isCrawling = false;
let crawlResults = null;
let lastOutputPath = null;

const databaseRoot = resolve(__dirname, "..", "database");

function resolveDatabasePath(inputPath) {
  const fallbackPath = join(databaseRoot, `sitemap-${Date.now()}.json`);
  const rawValue = String(inputPath || "").trim();

  if (!rawValue) {
    return fallbackPath;
  }

  const normalizedValue = rawValue.replace(/\\/g, "/");

  if (/^[a-zA-Z]:\//.test(normalizedValue) || normalizedValue.startsWith("/")) {
    const absolutePath = resolve(normalizedValue);
    return absolutePath.startsWith(databaseRoot + sep) || absolutePath === databaseRoot
      ? absolutePath
      : fallbackPath;
  }

  const candidatePath = resolve(databaseRoot, normalizedValue);
  return candidatePath.startsWith(databaseRoot + sep) || candidatePath === databaseRoot
    ? candidatePath
    : fallbackPath;
}

app.get("/api/status", (req, res) => {
  res.json({
    isCrawling,
    hasResults: !!crawlResults,
    results: crawlResults ? {
      startUrl: crawlResults.startUrl,
      totalPages: crawlResults.totalPages,
      pagesCount: crawlResults.pages?.length || 0
    } : null
  });
});

app.get("/api/results", (req, res) => {
  if (!crawlResults) {
    return res.status(404).json({ error: "No results available" });
  }
  res.json(crawlResults);
});

app.get("/api/results/download", (req, res) => {
  const resultPath = lastOutputPath ? join(__dirname, lastOutputPath) : null;

  if (crawlResults) {
    const fileName = lastOutputPath || `crawl-results-${Date.now()}.json`;
    return res
      .type("application/json")
      .setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
      .send(JSON.stringify(crawlResults, null, 2));
  }

  if (resultPath && fs.existsSync(resultPath)) {
    return res.download(resultPath);
  }

  return res.status(404).json({ error: "No results available for download" });
});

app.post("/api/crawl/start", (req, res) => {
  if (isCrawling) {
    return res.status(400).json({ error: "Crawl already in progress" });
  }

  const config = req.body || {};
  const startUrl = config.url || "https://crawlee.dev";
  const maxRequests = config.maxRequests || 100;
  const maxConcurrency = config.maxConcurrency || 1;
  const navigationTimeout = config.navigationTimeout || 45;
  const requestHandlerTimeout = config.requestHandlerTimeout || 180;
  const maxRetries = config.maxRetries || 1;
  const outputPath = resolveDatabasePath(config.databasePath || config.outputPath);
  const blockedResources = config.blockedResources || "image,font,media";
  const sensitiveWords =
    config.sensitiveWords || "delete,remove,pay,submit,confirm,logout,reset,clear,删除,注销,支付,清空,重置";
  const browserChannel = config.browserChannel || "";

  isCrawling = true;
  crawlResults = null;
  lastOutputPath = outputPath;

  io.emit("crawl:status", { status: "started", message: "Starting crawl..." });

  const args = [
    "--url", startUrl,
    "--max-requests", String(maxRequests),
    "--max-concurrency", String(maxConcurrency),
    "--navigation-timeout", String(navigationTimeout),
    "--request-handler-timeout", String(requestHandlerTimeout),
    "--max-retries", String(maxRetries),
    "--out", outputPath,
    "--database-path", outputPath,
    "--block-resources", blockedResources
  ];

  if (browserChannel) {
    args.push("--browser-channel", browserChannel);
  }

  const env = {
    ...process.env,
    START_URL: startUrl,
    MAX_REQUESTS: String(maxRequests),
    MAX_CONCURRENCY: String(maxConcurrency),
    NAVIGATION_TIMEOUT_SECS: String(navigationTimeout),
    REQUEST_HANDLER_TIMEOUT_SECS: String(requestHandlerTimeout),
    MAX_REQUEST_RETRIES: String(maxRetries),
    OUTPUT_PATH: outputPath,
    DATABASE_PATH: outputPath,
    BLOCK_RESOURCE_TYPES: blockedResources,
    SENSITIVE_WORDS: sensitiveWords,
    BROWSER_CHANNEL: browserChannel
  };

  currentProcess = exec(`node main.js ${args.join(" ")}`, {
    cwd: __dirname,
    env,
    maxBuffer: 50 * 1024 * 1024
  });

  let outputBuffer = "";
  let errorBuffer = "";

  currentProcess.stdout.on("data", (data) => {
    outputBuffer += data.toString();
    const lines = data.toString().split("\n").filter(line => line.trim());
    lines.forEach(line => {
      io.emit("crawl:log", { type: "info", message: line, timestamp: new Date().toISOString() });
    });
  });

  currentProcess.stderr.on("data", (data) => {
    errorBuffer += data.toString();
    const lines = data.toString().split("\n").filter(line => line.trim());
    lines.forEach(line => {
      io.emit("crawl:log", { type: "error", message: line, timestamp: new Date().toISOString() });
    });
  });

  currentProcess.on("close", (code) => {
    isCrawling = false;
    currentProcess = null;

    io.emit("crawl:status", { status: code === 0 ? "completed" : "failed", exitCode: code });

    try {
      if (fs.existsSync(outputPath)) {
        const rawData = fs.readFileSync(outputPath, "utf-8");
        crawlResults = JSON.parse(rawData);
        io.emit("crawl:complete", { results: crawlResults, outputPath });
      } else {
        io.emit("crawl:error", { error: "Output file not found" });
      }
    } catch (error) {
      io.emit("crawl:error", { error: error.message });
    }
  });

  currentProcess.on("error", (error) => {
    isCrawling = false;
    currentProcess = null;
    io.emit("crawl:status", { status: "error" });
    io.emit("crawl:error", { error: error.message });
  });

  res.json({ success: true, message: "Crawl started", config: { startUrl, maxRequests, outputPath } });
});

app.post("/api/crawl/stop", (req, res) => {
  if (!isCrawling || !currentProcess) {
    return res.status(400).json({ error: "No crawl in progress" });
  }

  currentProcess.kill("SIGTERM");
  isCrawling = false;
  currentProcess = null;

  io.emit("crawl:status", { status: "stopped", message: "Crawl stopped by user" });
  res.json({ success: true, message: "Crawl stopped" });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("crawl:status", {
    status: isCrawling ? "running" : "idle",
    hasResults: !!crawlResults,
    outputPath: lastOutputPath
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     🌐 Web Intelligent Function Navigation       ║
║                                                   ║
║     Server running at http://localhost:${PORT}       ║
╚═══════════════════════════════════════════════════╝
  `);
});
