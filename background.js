// Background service worker — fetches Kalshi markets and matches them to headlines (logic only; UI in content.js/style.css)

const KALSHI_APIS = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_EVENT_PAGES = 4; // trim for faster first fetch
const EVENTS_PAGE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 10000;

let marketsCache = { data: [], ts: 0, api: null };

// ---------------------------------------------------------------------------
// AI semantic matching via Cloudflare Workers AI (bge-small-en-v1.5, 384-dim)
// Set EMBED_API_URL to your deployed Worker URL to enable vector matching.
// Leave as null to use keyword + cluster matching only (still works great).
// ---------------------------------------------------------------------------
const EMBED_API_URL = null; // "https://headline-embed.YOUR-NAME.workers.dev"

let marketEmbeddings = new Map(); // ticker → Float32Array
let headlineEmbeddings = new Map(); // headline text → Float32Array
let embeddingCacheTs = 0; // tracks which marketsCache batch has been embedded

// Keep the MV3 service worker alive so content scripts can always reach it
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") return; // just wake the SW
});

function log(...args) {
  console.log("[Kalshi BG]", ...args);
}

function buildMarketUrl(market) {
  const direct = market.market_url || market.url || market.public_url || market.url_slug;
  if (direct) {
    if (direct.startsWith("http")) return direct;
    if (direct.startsWith("/")) return `https://kalshi.com${direct}`;
    return `https://kalshi.com/markets/${direct}`;
  }

  // Kalshi URLs are single-segment: /markets/{series_ticker} redirects correctly.
  // event_ticker (e.g. KXWITHDRAW-29) and market ticker 404; series_ticker (e.g. KXWITHDRAW) works.
  const seriesTicker = (market.series_ticker || "").toString();
  const eventTicker = (market.event_ticker || "").toString();
  const ticker = (market.ticker || "").toString();

  if (seriesTicker) return `https://kalshi.com/markets/${seriesTicker}`;
  if (eventTicker) return `https://kalshi.com/markets/${eventTicker}`;
  if (ticker) return `https://kalshi.com/markets/${ticker}`;
  return "https://kalshi.com/markets";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEvents(apiBase, cursor) {
  const params = new URLSearchParams({
    limit: String(EVENTS_PAGE_LIMIT),
    status: "open",
    with_nested_markets: "true",
  });
  if (cursor) params.set("cursor", cursor);

  const res = await fetchWithTimeout(`${apiBase}/events?${params}`);
  if (!res.ok) throw new Error(`Kalshi API ${res.status}`);
  return res.json();
}

async function getAllMarkets() {
  const now = Date.now();
  if (marketsCache.data.length && now - marketsCache.ts < CACHE_TTL) {
    return marketsCache.data;
  }

  const seenTickers = new Set();
  let allMarkets = [];
  let activeApi = null;

  for (const apiBase of KALSHI_APIS) {
    try {
      allMarkets = [];
      let cursor = null;

      for (let i = 0; i < MAX_EVENT_PAGES; i++) {
        const result = await fetchEvents(apiBase, cursor);
        const events = result.events || [];

        for (const event of events) {
          const category = event.category || "";
          const eventTitle = event.title || "";
          const markets = event.markets || [];
          const seriesTicker = event.series_ticker || event.event_ticker || "";

          for (const m of markets) {
            if (m.ticker && seenTickers.has(m.ticker)) continue;
            if (m.ticker) seenTickers.add(m.ticker);

            const close = m.close_time || m.expected_expiration_time;
            if (close && new Date(close).getTime() < Date.now()) continue;

            allMarkets.push({
              ticker: m.ticker,
              series_ticker: seriesTicker || m.series_ticker,
              event_ticker: m.event_ticker,
              title: m.title || eventTitle,
              subtitle: m.subtitle || event.sub_title || "",
              category,
              event_title: eventTitle,
              yes_bid: m.yes_bid,
              no_bid: m.no_bid,
              yes_ask: m.yes_ask,
              no_ask: m.no_ask,
              last_price: m.last_price,
              volume: m.volume,
              open_interest: m.open_interest,
              close_time: close,
              market_url: m.market_url || m.url || m.public_url || m.url_slug,
              url_slug: m.url_slug,
              // fallback URL built now so the content script can use it directly
              computed_url: buildMarketUrl({
                market_url: m.market_url || m.url || m.public_url || m.url_slug,
                ticker: m.ticker,
                series_ticker: seriesTicker || m.series_ticker,
                event_ticker: m.event_ticker,
                url_slug: m.url_slug,
              }),
            });
          }
        }

        cursor = result.cursor;
        if (!cursor || events.length < EVENTS_PAGE_LIMIT) break;
      }

      if (allMarkets.length > 0) {
        activeApi = apiBase;
        break;
      }
    } catch (err) {
      log(`API ${apiBase} failed, trying next:`, err.message || err);
      continue;
    }
  }

  if (!allMarkets.length || !activeApi) {
    throw new Error("No markets retrieved from any Kalshi API");
  }

  marketsCache = { data: allMarkets, ts: Date.now(), api: activeApi };
  log(`Cached ${allMarkets.length} markets from ${activeApi || "unknown"}`);

  // Non-blocking: embed market titles in background for semantic matching
  embedMarketsAsync(allMarkets);

  return allMarkets;
}

// ---------------------------------------------------------------------------
// Semantic topic clusters — groups of related terms so that cross-vocabulary
// headline↔market pairs (e.g. "Fed" headline ↔ "Federal Reserve" market) get
// a meaningful score boost even when exact keywords don't overlap.
// ---------------------------------------------------------------------------
const SEMANTIC_CLUSTERS = [
  {
    id: "fed_monetary",
    terms: [
      "federal reserve", "fed", "fomc", "interest rate", "rate hike", "rate cut",
      "monetary policy", "powell", "central bank", "quantitative easing", "qe",
      "federal funds", "basis points", "tightening", "easing", "inflation",
      "cpi", "pce", "deflation", "stagflation", "yellen", "treasury",
    ],
  },
  {
    id: "us_president",
    terms: [
      "president", "white house", "oval office", "trump", "biden", "harris", "obama",
      "executive order", "veto", "administration", "cabinet", "inauguration",
      "impeach", "resign", "pardon", "presidential",
    ],
  },
  {
    id: "us_elections",
    terms: [
      "election", "vote", "ballot", "primary", "candidate", "democrat", "republican",
      "senate", "senator", "congress", "house", "representative", "polling", "poll",
      "midterm", "runoff", "swing state", "electoral", "campaign", "nomination",
      "gop", "dnc", "rnc",
    ],
  },
  {
    id: "crypto",
    terms: [
      "bitcoin", "btc", "ethereum", "eth", "cryptocurrency", "crypto",
      "blockchain", "defi", "nft", "solana", "sol", "xrp", "ripple",
      "coinbase", "binance", "altcoin", "stablecoin", "usdc", "usdt",
      "tether", "digital asset", "token", "crypto regulation",
    ],
  },
  {
    id: "ai_tech",
    terms: [
      "artificial intelligence", "ai model", "large language model", "llm",
      "chatgpt", "gpt", "openai", "anthropic", "claude", "gemini", "grok",
      "nvidia", "semiconductor", "chip", "gpu", "microsoft", "google", "meta",
      "apple", "amazon", "agi", "machine learning", "deepseek",
    ],
  },
  {
    id: "geopolitics",
    terms: [
      "ukraine", "russia", "nato", "china", "taiwan", "middle east",
      "israel", "iran", "north korea", "sanctions", "military", "war",
      "ceasefire", "peace talks", "missile", "nuclear", "troops",
      "invasion", "conflict", "diplomacy", "treaty", "alliance", "putin", "zelensky",
    ],
  },
  {
    id: "markets_economy",
    terms: [
      "stock market", "dow jones", "nasdaq", "sp500", "wall street",
      "recession", "gdp", "unemployment", "jobs report", "earnings",
      "ipo", "merger", "acquisition", "bankruptcy", "tariff", "trade war",
      "debt ceiling", "fiscal", "stimulus", "economic growth", "labor market",
    ],
  },
  {
    id: "sports",
    terms: [
      "nfl", "super bowl", "nba", "nba finals", "world series", "mlb",
      "world cup", "fifa", "nhl", "stanley cup", "masters", "wimbledon",
      "us open", "olympics", "championship", "playoff", "bracket",
    ],
  },
  {
    id: "climate_energy",
    terms: [
      "climate", "carbon", "emissions", "renewable energy", "solar", "wind power",
      "oil", "crude", "opec", "natural gas", "lng", "gasoline", "petroleum",
      "paris accord", "net zero", "clean energy", "electric vehicle",
    ],
  },
  {
    id: "health_pharma",
    terms: [
      "fda", "approval", "drug", "vaccine", "pharmaceutical", "biotech",
      "clinical trial", "pfizer", "moderna", "medicare", "medicaid",
      "healthcare", "covid", "pandemic", "who", "cancer", "treatment",
    ],
  },
  {
    id: "legal_justice",
    terms: [
      "supreme court", "scotus", "ruling", "lawsuit", "indictment", "trial",
      "verdict", "conviction", "acquittal", "appeal", "attorney general",
      "doj", "fbi", "department of justice", "constitution", "amendment",
    ],
  },
  {
    id: "elon_musk_doge",
    terms: [
      "elon musk", "musk", "tesla", "spacex", "starlink", "twitter", "x corp",
      "doge", "department of government efficiency", "xai",
    ],
  },
];

// ---------------------------------------------------------------------------
// Vector embedding helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchEmbeddings(texts) {
  if (!EMBED_API_URL || texts.length === 0) return null;
  try {
    const res = await fetchWithTimeout(
      EMBED_API_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      },
      8000
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.embeddings || null;
  } catch {
    return null;
  }
}

/**
 * Embeds all market titles via the CF Worker and stores vectors in
 * `marketEmbeddings`. Called non-blocking after markets are fetched.
 */
async function embedMarketsAsync(markets) {
  if (!EMBED_API_URL) return;
  if (embeddingCacheTs === marketsCache.ts) return; // already done for this batch

  log(`Embedding ${markets.length} markets via CF Worker...`);
  const BATCH = 50;
  const newEmbeddings = new Map();

  for (let i = 0; i < markets.length; i += BATCH) {
    const slice = markets.slice(i, i + BATCH);
    const texts = slice.map((m) =>
      [m.title, m.subtitle, m.event_title].filter(Boolean).join(" ").slice(0, 256)
    );
    const vecs = await fetchEmbeddings(texts);
    if (!vecs) { log("Embedding batch failed — stopping"); break; }
    slice.forEach((m, j) => {
      if (vecs[j]) newEmbeddings.set(m.ticker, new Float32Array(vecs[j]));
    });
  }

  if (newEmbeddings.size > 0) {
    marketEmbeddings = newEmbeddings;
    embeddingCacheTs = marketsCache.ts;
    log(`Stored ${newEmbeddings.size} market embeddings`);
  }
}

/** Return the set of cluster IDs that the given text belongs to. */
function getClusters(text) {
  const lower = text.toLowerCase();
  const matched = new Set();
  for (const cluster of SEMANTIC_CLUSTERS) {
    for (const term of cluster.terms) {
      if (lower.includes(term)) {
        matched.add(cluster.id);
        break; // one term hit is enough per cluster
      }
    }
  }
  return matched;
}

function extractKeywords(text) {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "because", "but", "and", "or",
    "if", "while", "about", "up", "its", "it", "this", "that", "these",
    "those", "he", "she", "they", "them", "his", "her", "their", "what",
    "which", "who", "whom", "new", "says", "said", "report", "reports",
    "according", "could", "also", "get", "gets", "got", "going", "make",
    "makes", "made", "take", "takes", "look", "year", "years", "day",
    "days", "week", "weeks", "month", "months", "time", "way", "us",
    "back", "first", "last", "next", "now", "still", "even", "many",
    "much", "well", "long", "right", "left", "big", "old", "high", "low",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function scoreMatch(headlineKw, headlineClusters, headlineVec, market) {
  const marketText = [
    market.title,
    market.subtitle,
    market.event_title,
    market.category,
  ]
    .join(" ")
    .toLowerCase();

  const marketKw = new Set(extractKeywords(marketText));

  let matches = 0;
  const matched = [];
  for (const kw of headlineKw) {
    if (marketKw.has(kw) || marketText.includes(kw)) {
      matches++;
      matched.push(kw);
    }
  }

  // Semantic cluster bonus: if headline and market share a topic cluster, boost
  // the score significantly — this handles cross-vocabulary matches like
  // "Powell signals pause" ↔ "Will the Fed hold rates steady?"
  const marketClusters = getClusters(marketText);
  let clusterBonus = 0;
  for (const c of headlineClusters) {
    if (marketClusters.has(c)) {
      clusterBonus = 0.4;
      break;
    }
  }

  // Require at least one signal to proceed
  if (matches === 0 && clusterBonus === 0) return 0;
  // Pure cluster match (no keyword overlap) — low but non-zero score
  if (matches === 0) return clusterBonus * 0.5;

  const bonus = matched.reduce((sum, kw) => sum + (kw.length > 5 ? 0.1 : 0), 0);

  let bigramBonus = 0;
  for (let i = 0; i < headlineKw.length - 1; i++) {
    const bg = `${headlineKw[i]} ${headlineKw[i + 1]}`;
    if (bg.length > 6 && marketText.includes(bg)) {
      bigramBonus = 0.2;
      break;
    }
  }

  let recency = 0;
  if (market.close_time) {
    const hours = (new Date(market.close_time).getTime() - Date.now()) / 3600000;
    if (hours > 0 && hours < 24 * 7) recency = 0.2;
  }

  // Vector semantic bonus: cosine similarity between headline and market embeddings.
  // Only applied when embeddings are available (EMBED_API_URL is set).
  // Similarity must exceed 0.5 to avoid noise from weakly-related topics.
  let semanticBonus = 0;
  const marketVec = marketEmbeddings.get(market.ticker);
  if (headlineVec && marketVec) {
    const sim = cosineSimilarity(headlineVec, marketVec);
    if (sim > 0.5) semanticBonus = (sim - 0.5) * 1.0; // 0–0.45 range
  }

  return matches / headlineKw.length + bonus + bigramBonus + clusterBonus + recency + semanticBonus;
}

function findMatches(headline, markets) {
  const headlineKw = extractKeywords(headline);
  const headlineClusters = getClusters(headline);
  const headlineVec = headlineEmbeddings.get(headline) || null;

  // Need at least one keyword or one cluster match to be worth scoring
  if (headlineKw.length < 1 && headlineClusters.size === 0) return [];

  const scored = markets
    .map((m) => ({ market: m, score: scoreMatch(headlineKw, headlineClusters, headlineVec, m) }))
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((s) => ({
    ticker: s.market.ticker,
    series_ticker: s.market.series_ticker,
    event_ticker: s.market.event_ticker,
    title: s.market.title,
    subtitle: s.market.subtitle || "",
    category: s.market.category,
    yes_bid: s.market.yes_bid,
    no_bid: s.market.no_bid,
    last_price: s.market.last_price,
    volume: s.market.volume,
    open_interest: s.market.open_interest,
    close_time: s.market.close_time,
    url: s.market.computed_url || buildMarketUrl(s.market),
    score: s.score,
  }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "WARM_CACHE") {
    getAllMarkets()
      .then((markets) => sendResponse({ ok: true, marketCount: markets.length, api: marketsCache.api }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type !== "MATCH_HEADLINES") return;

  getAllMarkets()
    .then(async (markets) => {
      // Batch-embed all headlines that aren't cached yet (one round-trip to CF Worker)
      if (EMBED_API_URL) {
        const toEmbed = [...new Set(msg.headlines)].filter(
          (h) => !headlineEmbeddings.has(h)
        );
        if (toEmbed.length > 0) {
          const vecs = await fetchEmbeddings(toEmbed);
          if (vecs) {
            toEmbed.forEach((h, i) => {
              if (vecs[i]) headlineEmbeddings.set(h, new Float32Array(vecs[i]));
            });
          }
        }
      }

      const results = {};
      for (const headline of msg.headlines) {
        const matches = findMatches(headline, markets);
        if (matches.length) results[headline] = matches;
      }
      sendResponse({ ok: true, results, marketCount: markets.length, api: marketsCache.api });
    })
    .catch((err) => {
      console.error("Kalshi fetch error:", err);
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});
