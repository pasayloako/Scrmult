const axios = require("axios");

const MULTISAVE_API = "https://multisave.freedev.app/api.php";
const REQUEST_TIMEOUT_MS = 30_000;

function validateUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A media URL is required.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid media URL.");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  return url.toString();
}

function getMode(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");

  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube-mp4";
  if (["spotify.com", "open.spotify.com"].includes(host)) return "spotify";
  if (["instagram.com", "instagr.am"].includes(host)) return "instagram";
  if (host === "threads.net") return "threads";
  if (["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) return "tiktok";

  // Facebook, X, Pinterest, Snapchat, CapCut, and Likee use
  // MultiSave's generic request path in the public frontend.
  return "generic";
}

async function scrape(url, options = {}) {
  try {
    const targetUrl = validateUrl(url);
    const mode = options.mode || getMode(targetUrl);

    const response = await axios.post(
      MULTISAVE_API,
      { url: targetUrl, mode },
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://multisave.freedev.app",
          Referer: "https://multisave.freedev.app/",
          "User-Agent": "Mozilla/5.0 MultiSaveClient/1.0"
        },
        validateStatus: () => true
      }
    );

    const payload = response.data;

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MultiSave returned HTTP ${response.status}.`);
    }

    if (!payload || !payload.result) {
      throw new Error(
        payload?.message || payload?.error || "MultiSave did not return a downloadable media URL."
      );
    }

    if (typeof payload.result !== "string" || !/^https?:\/\//i.test(payload.result)) {
      throw new Error("MultiSave returned an invalid media URL.");
    }

    return {
      status: true,
      result: {
        title: typeof payload.videoTitle === "string" && payload.videoTitle.trim()
          ? payload.videoTitle.trim()
          : "Downloaded media",
        author: typeof payload.author === "string" ? payload.author.trim() : "",
        thumbnail: typeof payload.imageUrl === "string" ? payload.imageUrl : "",
        type: "video",
        downloads: [
          {
            url: payload.result,
            type: "video"
          }
        ]
      }
    };
  } catch (error) {
    return {
      status: false,
      message: error.response?.data?.message || error.response?.data?.error || error.message || "MultiSave request failed."
    };
  }
}

module.exports = { scrape };
