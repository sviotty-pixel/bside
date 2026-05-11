/**
 * Local dev server for the static B:SIDE site + /api/generate-review proxy.
 *
 * The frontend in index.html calls:
 *   POST /api/generate-review
 *
 * This server serves static files from the repo root and implements that API
 * by proxying to OpenAI (so your API key stays server-side).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const repoRoot = __dirname;

function sendJson(res, status, obj, headers = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

function sendCors(res) {
  // Matches the upstream serverless function behavior.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function safeResolveStatic(requestPath) {
  // Prevent path traversal: resolve within repoRoot and reject escapes.
  const decoded = decodeURIComponent(requestPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const absPath = path.join(repoRoot, normalized);

  if (!absPath.startsWith(repoRoot)) return null;
  return absPath;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Simple guardrail; this endpoint expects small JSON.
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleGenerateReview(req, res) {
  sendCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJsonBody(req).catch(() => null);
  const movieTitle = body?.movieTitle;

  if (!movieTitle || typeof movieTitle !== "string" || !movieTitle.trim()) {
    sendJson(res, 400, { error: "movieTitle is required" });
    return;
  }

  const cleanTitle = movieTitle.trim().slice(0, 80);

  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Server is missing OPENAI_API_KEY env var" });
    return;
  }

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an unhinged AI film critic who writes revisionist cult reviews. Voice: obsessive, conspiratorial, sincere. Output ONLY valid JSON, no backticks, no markdown.",
          },
          {
            role: "user",
            content:
              'Write an AI-generated cult film review for: "' +
              cleanTitle +
              '". Return ONLY a JSON object with these exact keys: title (movie name in caps), badge (3-4 word label in caps, e.g. "CRIMINALLY MISUNDERSTOOD"), rating ("5/5"), excerpt (2 sentence hook), full (150-word unhinged cult review). No markdown.',
          },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "");
      console.error("OpenAI error:", openaiRes.status, errBody);
      sendJson(res, 502, { error: "OpenAI request failed", status: openaiRes.status });
      return;
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content || "";

    // The model is asked for raw JSON; strip any stray fences just in case.
    const cleaned = String(content).replace(/```json|```/g, "").trim();

    let review;
    try {
      review = JSON.parse(cleaned);
    } catch {
      // Fallback shape so the frontend never breaks.
      review = {
        title: cleanTitle.toUpperCase(),
        badge: "MISUNDERSTOOD MASTERPIECE",
        rating: "5/5",
        excerpt: cleaned.slice(0, 140) + "...",
        full: cleaned,
      };
    }

    sendJson(res, 200, review);
  } catch (err) {
    console.error("Handler error:", err);
    sendJson(res, 500, { error: "Server error" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/generate-review") {
      await handleGenerateReview(req, res);
      return;
    }

    // Static file serving (repo root)
    let requestPath = url.pathname;
    if (requestPath === "/") requestPath = "/index.html";

    const absPath = safeResolveStatic(requestPath);
    if (!absPath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(absPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const type = contentTypeFor(absPath);
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`[bside] Local server running at http://localhost:${PORT}`);
  console.log(`[bside] OPENAI_API_KEY is ${OPENAI_API_KEY ? "set" : "NOT set"}`);
});

