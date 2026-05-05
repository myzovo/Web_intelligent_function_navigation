import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join, basename, extname } from "path";
import { spawn } from "child_process";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const outputsDir = join(__dirname, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });
const databaseDir = join(__dirname, "database");
fs.mkdirSync(databaseDir, { recursive: true });

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

app.get("/api/status", (_req, res) => {
  res.json({
    isCrawling,
    hasResults: !!crawlResults,
    outputPath: lastOutputPath ? basename(lastOutputPath) : null,
    results: crawlResults
      ? {
          startUrl: crawlResults.startUrl,
          totalPages: crawlResults.totalPages,
          pagesCount: crawlResults.pages?.length || 0
        }
      : null
  });
});

app.get("/api/results", (_req, res) => {
  if (!crawlResults) {
    return res.status(404).json({ error: "No results available" });
  }
  res.json(crawlResults);
});

app.get("/api/datasets", (_req, res) => {
  try {
    const files = buildDatabaseIndex();
    res.setHeader("Cache-Control", "no-store");
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: "Failed to read database directory" });
  }
});

app.get("/api/datasets/:name", (req, res) => {
  const filePath = resolveDatasetPath(req.params.name);
  if (!filePath) {
    return res.status(400).json({ error: "Invalid dataset name" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Dataset not found" });
  }

  try {
    const rawData = fs.readFileSync(filePath, "utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.type("application/json").send(rawData);
  } catch (error) {
    res.status(500).json({ error: "Failed to read dataset file" });
  }
});

app.get("/api/datasets", (_req, res) => {
  try {
    const items = listDatabaseFiles();
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: "Failed to list datasets" });
  }
});

app.get("/api/datasets/:name", (req, res) => {
  const raw = req.params.name || "";
  const fileName = basename(raw);

  if (fileName !== raw) {
    return res.status(400).json({ error: "Invalid file name" });
  }

  if (extname(fileName).toLowerCase() !== ".json") {
    return res.status(400).json({ error: "Only .json files are supported" });
  }

  const filePath = join(databaseDir, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Dataset not found" });
  }

  try {
    const payload = fs.readFileSync(filePath, "utf-8");
    res.type("application/json").send(payload);
  } catch (error) {
    res.status(500).json({ error: "Failed to read dataset" });
  }
});

app.get("/api/results/download", (_req, res) => {
  if (lastOutputPath && fs.existsSync(lastOutputPath)) {
    return res.download(lastOutputPath, basename(lastOutputPath));
  }

  if (crawlResults) {
    res
      .type("application/json")
      .setHeader("Content-Disposition", "attachment; filename=results.json")
      .send(JSON.stringify(crawlResults, null, 2));
    return;
  }

  res.status(404).json({ error: "No output file available" });
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
  const blockedResources = config.blockedResources || "image,font,media";
  const sensitiveWords =
    config.sensitiveWords || "delete,remove,pay,submit,confirm,logout,reset,clear,删除,注销,支付,清空,重置";
  const browserChannel = config.browserChannel || "";

  const outputName = normalizeOutputName(config.outputPath);
  const outputPath = join(outputsDir, outputName);

  isCrawling = true;
  crawlResults = null;
  lastOutputPath = outputPath;

  io.emit("crawl:status", { status: "started", message: "Starting crawl..." });

  const args = [
    "--url",
    startUrl,
    "--max-requests",
    String(maxRequests),
    "--max-concurrency",
    String(maxConcurrency),
    "--navigation-timeout",
    String(navigationTimeout),
    "--request-handler-timeout",
    String(requestHandlerTimeout),
    "--max-retries",
    String(maxRetries),
    "--out",
    outputPath,
    "--block-resources",
    blockedResources
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

  const mainPath = join(__dirname, "main.js");
  currentProcess = spawn("node", [mainPath, ...args], {
    cwd: __dirname,
    env
  });

  currentProcess.stdout.on("data", (data) => {
    const lines = data
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    lines.forEach((line) => {
      io.emit("crawl:log", { type: "info", message: line, timestamp: new Date().toISOString() });
    });
  });

  currentProcess.stderr.on("data", (data) => {
    const lines = data
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    lines.forEach((line) => {
      io.emit("crawl:log", { type: "error", message: line, timestamp: new Date().toISOString() });
    });
  });

  currentProcess.on("close", (code) => {
    isCrawling = false;
    currentProcess = null;

    io.emit("crawl:status", { status: code === 0 ? "completed" : "failed", exitCode: code });

    try {
      if (lastOutputPath && fs.existsSync(lastOutputPath)) {
        const rawData = fs.readFileSync(lastOutputPath, "utf-8");
        crawlResults = JSON.parse(rawData);
        io.emit("crawl:complete", { results: crawlResults, outputPath: lastOutputPath });
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

  res.json({
    success: true,
    message: "Crawl started",
    config: { startUrl, maxRequests, outputPath: outputName }
  });
});

app.post("/api/crawl/stop", (_req, res) => {
  if (!isCrawling || !currentProcess) {
    return res.status(400).json({ error: "No crawl in progress" });
  }

  currentProcess.kill();
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
    outputPath: lastOutputPath ? basename(lastOutputPath) : null
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3456;

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     Web Intelligent Function Navigation          ║
║                                                   ║
║     Server running at http://localhost:${PORT}       ║
╚═══════════════════════════════════════════════════╝
  `);
});

function normalizeOutputName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return `sitemap-${Date.now()}.json`;
  return basename(trimmed);
}

function buildDatabaseIndex() {
  const entries = fs.readdirSync(databaseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => {
      const filePath = join(databaseDir, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        size: stats.size,
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function resolveDatasetPath(rawName) {
  const safeName = basename(String(rawName || "").trim());
  if (!safeName || safeName !== rawName) {
    return null;
  }
  if (!safeName.toLowerCase().endsWith(".json")) {
    return null;
  }
  return join(databaseDir, safeName);
}

function listDatabaseFiles() {
  if (!fs.existsSync(databaseDir)) {
    return [];
  }

  return fs
    .readdirSync(databaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".json")
    .map((entry) => {
      const fullPath = join(databaseDir, entry.name);
      const stats = fs.statSync(fullPath);
      return {
        name: entry.name,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
