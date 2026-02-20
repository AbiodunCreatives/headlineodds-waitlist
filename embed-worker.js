// embed-worker.js — Cloudflare Worker for semantic text embeddings
// ---------------------------------------------------------------
// DEPLOY STEPS:
//   1. Go to https://workers.cloudflare.com → Create Worker
//   2. Paste this file, then click "Save & Deploy"
//   3. In the Worker settings → Bindings → Add → AI binding named "AI"
//   4. Copy the Worker URL (e.g. https://headline-embed.YOUR-NAME.workers.dev)
//   5. Paste it into EMBED_API_URL in background.js
//   6. Add the URL to host_permissions in manifest.json
//
// Model: @cf/baai/bge-small-en-v1.5  (384-dim, free tier)
// Cloudflare free tier: 10,000 neurons/day — more than enough for this use.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { texts } = body;
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 100) {
      return json({ error: "texts must be a non-empty array of up to 100 strings" }, 400);
    }

    try {
      const result = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: texts });
      return json({ embeddings: result.data });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
