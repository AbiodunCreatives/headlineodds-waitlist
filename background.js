// Background service worker — fetches Kalshi markets and matches them to headlines (logic only; UI in content.js/style.css)

const KALSHI_APIS = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_EVENT_PAGES = 6;
const EVENTS_PAGE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 10000;

let marketsCache = { data: [], ts: 0, api: null };

function log(...args) {
  console.log("[Kalshi BG]", ...args);
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
    allMarkets = [];
    let cursor = null;

    for (let i = 0; i < MAX_EVENT_PAGES; i++) {
      const result = await fetchEvents(apiBase, cursor);
      const events = result.events || [];

      for (const event of events) {
        const category = event.category || "";
        const eventTitle = event.title || "";
        const markets = event.markets || [];

        for (const m of markets) {
          if (m.ticker && seenTickers.has(m.ticker)) continue;
          if (m.ticker) seenTickers.add(m.ticker);

          const close = m.close_time || m.expected_expiration_time;
          if (close && new Date(close).getTime() < Date.now()) continue;

          allMarkets.push({
            ticker: m.ticker,
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
  }

  marketsCache = { data: allMarkets, ts: Date.now(), api: activeApi };
  log(`Cached ${allMarkets.length} markets from ${activeApi || "unknown"}`);
  return allMarkets;
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

function scoreMatch(headlineKw, market) {
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

  if (matches < 2) return 0;

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

  return matches / headlineKw.length + bonus + bigramBonus + recency;
}

function findMatches(headline, markets) {
  const headlineKw = extractKeywords(headline);
  if (headlineKw.length < 2) return [];

  const scored = markets
    .map((m) => ({ market: m, score: scoreMatch(headlineKw, m) }))
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((s) => ({
    ticker: s.market.ticker,
    title: s.market.title,
    subtitle: s.market.subtitle || "",
    category: s.market.category,
    yes_bid: s.market.yes_bid,
    no_bid: s.market.no_bid,
    last_price: s.market.last_price,
    volume: s.market.volume,
    open_interest: s.market.open_interest,
    close_time: s.market.close_time,
    url: `https://kalshi.com/markets/${(s.market.ticker || "").toLowerCase()}`,
    score: s.score,
  }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "MATCH_HEADLINES") return;

  getAllMarkets()
    .then((markets) => {
      const results = {};
      for (const headline of msg.headlines) {
        const matches = findMatches(headline, markets);
        if (matches.length) {
          results[headline] = matches;
        }
      }
      sendResponse({ ok: true, results, marketCount: markets.length, api: marketsCache.api });
    })
    .catch((err) => {
      console.error("Kalshi fetch error:", err);
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});
