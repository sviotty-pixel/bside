// Vercel Serverless Function: POST /api/generate-review
// Proxies cult-review generation requests to OpenAI so the API key stays server-side.
//
// SETUP:
//   1. Deploy this file at: <repo-root>/api/generate-review.js
//   2. In Vercel dashboard: Settings -> Environment Variables, add:
//        OPENAI_API_KEY = sk-...your-real-key...
//   3. Redeploy. The endpoint will live at: https://<your-project>.vercel.app/api/generate-review

export default async function handler(req, res) {
  // CORS — allow your GitHub Pages site (or any origin) to call this endpoint.
  // Tighten this in production by replacing "*" with your actual deployed URL.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { movieTitle } = req.body || {};
  if (!movieTitle || typeof movieTitle !== "string" || !movieTitle.trim()) {
    return res.status(400).json({ error: "movieTitle is required" });
  }

  // Light rate-limit-friendly cap to keep usage bills sane
  const cleanTitle = movieTitle.trim().slice(0, 80);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENAI_API_KEY env var" });
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
      const errBody = await openaiRes.text();
      console.error("OpenAI error:", openaiRes.status, errBody);
      return res
        .status(502)
        .json({ error: "OpenAI request failed", status: openaiRes.status });
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content || "";

    // The model is asked for raw JSON; strip any stray fences just in case.
    const cleaned = content.replace(/```json|```/g, "").trim();

    let review;
    try {
      review = JSON.parse(cleaned);
    } catch (e) {
      // Fallback shape so the frontend never breaks
      review = {
        title: cleanTitle.toUpperCase(),
        badge: "MISUNDERSTOOD MASTERPIECE",
        rating: "5/5",
        excerpt: cleaned.slice(0, 140) + "...",
        full: cleaned,
      };
    }

    return res.status(200).json(review);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
