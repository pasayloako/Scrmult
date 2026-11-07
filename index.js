const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_HOST = "multisave.freedev.app";
const MAX_PAGES = 8;
const MAX_RESPONSE_BYTES = 1_500_000;
const TIMEOUT_MS = 15000;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

// Optional CORS configuration. Set ALLOWED_ORIGIN to your scraper frontend URL.
// Example: ALLOWED_ORIGIN=https://your-scraper-site.example
app.use((req, res, next) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin;

  if (!allowedOrigin || origin === allowedOrigin) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function normalizeTarget(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(input.trim().startsWith("http")
      ? input.trim()
      : `https://${input.trim()}`);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed.");
  }
  if (parsed.hostname.toLowerCase() !== ALLOWED_HOST) {
    throw new Error(`Only ${ALLOWED_HOST} is allowed.`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Custom ports are not allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  parsed.hash = "";
  return parsed.toString();
}

function resolveSameSite(candidate, baseUrl) {
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== ALLOWED_HOST) {
      return null;
    }
    if (url.port && url.port !== "443") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || "(No page title found)";
  const meta = {};

  $("meta[name], meta[property]").each((_, element) => {
    const key = ($(element).attr("name") || $(element).attr("property") || "").trim();
    const value = ($(element).attr("content") || "").trim();
    if (key && value) meta[key] = value;
  });

  const description = meta.description || meta["og:description"] || "";
  const canonicalRaw = $('link[rel~="canonical"]').first().attr("href") || "";
  const canonical = canonicalRaw ? resolveSameSite(canonicalRaw, pageUrl) : "";

  const headings = [];
  $("h1, h2, h3").each((_, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (text) headings.push({ tag: element.tagName.toLowerCase(), text });
  });

  const linkMap = new Map();
  $("a[href]").each((_, element) => {
    const url = resolveSameSite($(element).attr("href"), pageUrl);
    if (!url || linkMap.has(url)) return;
    linkMap.set(url, {
      text: $(element).text().replace(/\s+/g, " ").trim() || "(no link text)",
      url
    });
  });

  const imageMap = new Map();
  $("img[src]").each((_, element) => {
    const src = resolveSameSite($(element).attr("src"), pageUrl);
    if (!src || imageMap.has(src)) return;
    imageMap.set(src, {
      alt: ($(element).attr("alt") || "").trim(),
      src
    });
  });

  return {
    title,
    description,
    canonical,
    meta,
    headings: headings.slice(0, 30),
    links: [...linkMap.values()].slice(0, 100),
    images: [...imageMap.values()].slice(0, 50)
  };
}

async function fetchPublicPage(url) {
  const response = await axios.get(url, {
    responseType: "text",
    timeout: TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: status => status >= 200 && status < 400,
    headers: {
      "User-Agent": "MultiSavePublicScraperAPI/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  // Do not follow redirects: a redirect may point off-site.
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`HTTP ${response.status}: redirect was not followed.`);
  }

  const contentType = String(response.headers["content-type"] || "");
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Expected HTML but received ${contentType}.`);
  }

  // Never return Set-Cookie, authentication challenges, or request headers.
  const safeHeaders = {};
  const blocked = new Set(["set-cookie", "set-cookie2", "www-authenticate", "proxy-authenticate"]);
  for (const [key, value] of Object.entries(response.headers)) {
    if (!blocked.has(key.toLowerCase())) {
      safeHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }

  return {
    status: response.status,
    contentType,
    headers: safeHeaders,
    html: response.data
  };
}

async function scrapeWebsite(startUrl, crawlEnabled) {
  const queue = [startUrl];
  const visited = new Set();
  const pages = [];
  const errors = [];

  while (queue.length && visited.size < (crawlEnabled ? MAX_PAGES : 1)) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const response = await fetchPublicPage(url);
      const data = parseHtml(response.html, url);

      pages.push({
        url,
        status: response.status,
        contentType: response.contentType,
        headers: response.headers,
        data
      });

      if (crawlEnabled) {
        for (const link of data.links) {
          if (!visited.has(link.url) && !queue.includes(link.url) &&
              visited.size + queue.length < MAX_PAGES) {
            queue.push(link.url);
          }
        }
      }
    } catch (error) {
      errors.push({ url, error: error.message });
    }
  }

  return {
    success: pages.length > 0,
    target: startUrl,
    checked: visited.size,
    pageCount: pages.length,
    errorCount: errors.length,
    pages,
    errors
  };
}

app.get("/", (req, res) => {
  res.json({
    name: "MultiSave Public Scraper API",
    version: "1.0.0",
    endpoints: {
      health: "GET /api/health",
      scrape: "GET /api/scrape?url=https%3A%2F%2Fmultisave.freedev.app%2F",
      crawl: "GET /api/scrape?url=https%3A%2F%2Fmultisave.freedev.app%2F&crawl=true"
    },
    allowedHost: ALLOWED_HOST
  });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "online", service: "MultiSave Public Scraper API" });
});

app.get("/api/scrape", async (req, res) => {
  try {
    const target = normalizeTarget(req.query.url || `https://${ALLOWED_HOST}/`);
    const crawl = String(req.query.crawl || "false").toLowerCase() === "true";
    const result = await scrapeWebsite(target, crawl);
    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Avoid accidentally running as an open proxy: only the fixed host can be scraped.
app.listen(PORT, () => {
  console.log(`MultiSave Scraper API listening on port ${PORT}`);
});
