const express = require("express");
const path = require("path");
const { scrape } = require("./multisave-client");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Set ALLOWED_ORIGIN in Render, for example:
// ALLOWED_ORIGIN=https://your-frontend.example.com
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigin = process.env.ALLOWED_ORIGIN;

  if (origin && (!allowedOrigin || origin === allowedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    service: "MultiSave API"
  });
});

async function handleDownload(req, res) {
  const url = req.body?.url || req.query?.url;
  const mode = req.body?.mode || req.query?.mode;

  if (!url) {
    return res.status(400).json({
      status: false,
      message: "A public media URL is required."
    });
  }

  const result = await scrape(url, { mode });
  res.status(result.status ? 200 : 502).json(result);
}

// Recommended API endpoint:
// POST /api/download
// { "url": "https://www.facebook.com/..." }
app.post("/api/download", async (req, res) => {
  try {
    await handleDownload(req, res);
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
});

// Backward-compatible endpoint for the existing public/index.html.
app.get("/api/scrape", async (req, res) => {
  try {
    await handleDownload(req, res);
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MultiSave API listening on port ${PORT}`);
});
