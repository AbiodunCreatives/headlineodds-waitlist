
(function () {
  if (window.__kalshiInjected) return;
  window.__kalshiInjected = true;

  const HEADLINE_SELECTORS = [
    "h1",
    "h2",
    "h3",
    "[data-testid*='headline']",
    ".story-body__h1",
    ".headline",
    ".article-title",
    ".post-title",
    ".titleline > a",
    "[class*='Headline']",
    "[class*='headline']",
    "[class*='title']",
  ].join(", ");

  const MIN_HEADLINE_LEN = 20;
  const MAX_HEADLINE_LEN = 300;
  const processedElements = new WeakSet();
  const headlinePills = new Map(); // headline -> pill
  const headlineMarkets = new Map(); // headline -> last good markets
  let activeCard = null;
  const LOGO_URL = chrome.runtime.getURL("logo.png");
  const FALLBACK_LOGO_URL = chrome.runtime.getURL("icons/icon16.png");

  function getHeadlineText(el) {
    const text = (el.innerText || el.textContent || "").trim();
    if (text.length < MIN_HEADLINE_LEN || text.length > MAX_HEADLINE_LEN) return null;
    if (el.closest("nav, header:not(.article-header), footer, [role='navigation'], .kalshi-market-card")) return null;
    return text;
  }

  function collectHeadlines() {
    const elements = document.querySelectorAll(HEADLINE_SELECTORS);
    const headlines = [];
    const headlineMap = new Map();

    elements.forEach((el) => {
      if (processedElements.has(el)) return;
      const text = getHeadlineText(el);
      if (!text) return;
      if (headlineMap.has(text)) return;
      headlineMap.set(text, el);
      headlines.push(text);
    });

    return { headlines, headlineMap };
  }

  function createFetchingPill() {
    const pill = document.createElement("span");
    pill.className = "kalshi-odds-pill kalshi-pill-fetching";
    pill.textContent = "Market odds";
    return pill;
  }

  function updatePill(pill, headline, markets) {
    // preserve last successful markets so the pill doesn't vanish on transient misses
    if (markets && markets.length) {
      headlineMarkets.set(headline, markets);
    }
    const data = headlineMarkets.get(headline);

    pill.className = "kalshi-odds-pill";

    if (!data || !data.length) {
      pill.style.display = "none";
      pill.onclick = null;
      return;
    }

    pill.style.display = "inline-flex";

    pill.innerHTML = `<span class="kalshi-pill-icon"></span><span class="kalshi-pill-text">Market odds</span>`;
    pill.title = "View Kalshi market odds";
    pill._marketData = data;
    pill._card = null; // force rebuild if data changed
    pill.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCard(pill, data, headline);
    };
  }

  function toggleCard(pill, marketData, headline) {
    const data = pill._marketData || marketData;
    if (!data || !data.length) return;

    const card = pill._card || (pill._card = buildCard(pill, data, headline));

    if (activeCard) {
      activeCard.remove();
      if (activeCard._pill === pill) {
        activeCard = null;
        return;
      }
      activeCard = null;
    }

    // Position card directly under pill
    const rect = pill.getBoundingClientRect();
    card.style.position = "fixed";
    card.style.zIndex = "2147483647";
    document.body.appendChild(card);

    const cardRect = card.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;

    if (top + cardRect.height > window.innerHeight) {
      top = rect.top - cardRect.height - 6;
    }
    if (left + cardRect.width > window.innerWidth) {
      left = window.innerWidth - cardRect.width - 10;
    }
    if (left < 6) left = 6;

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    makeDraggable(card, card.querySelector(".kalshi-card-header"));

    activeCard = card;
  }

  function buildCard(pill, marketData, headline) {
    const card = document.createElement("div");
    card.className = "kalshi-market-card";
    card._pill = pill;

    card.innerHTML = `
      <div class="kalshi-card-header">
        <div class="kalshi-card-title">
          <img src="${LOGO_URL}" onerror="this.src='${FALLBACK_LOGO_URL}'" alt="logo" class="kalshi-card-logo-img" />
          <span>ODDS ON THIS STORY</span>
        </div>
        <button class="kalshi-card-close" aria-label="Close">✕</button>
      </div>
      <div class="kalshi-card-body"></div>
      ${marketData.length > 1 ? `
      <div class="kalshi-card-nav">
        <button class="kalshi-nav-btn kalshi-nav-prev" aria-label="Previous market">‹</button>
        <span class="kalshi-card-index"></span>
        <button class="kalshi-nav-btn kalshi-nav-next" aria-label="Next market">›</button>
      </div>` : ""}
      <a class="kalshi-cta" href="${normalizeKalshiUrl(marketData[0].url, marketData[0].ticker)}" target="_blank" rel="noopener">View market</a>
      <div class="kalshi-powered">Powered by <span>Kalshi</span></div>
    `;
    // defensive: ensure no pills render inside card
    card.querySelectorAll(".kalshi-odds-pill").forEach((p) => p.remove());

    card.querySelector(".kalshi-card-close").addEventListener("click", (e) => {
      e.stopPropagation();
      card.remove();
      activeCard = null;
    });

    const cardBody = card.querySelector(".kalshi-card-body");
    const indexEl = card.querySelector(".kalshi-card-index");
    const prevBtn = card.querySelector(".kalshi-nav-prev");
    const nextBtn = card.querySelector(".kalshi-nav-next");
    let current = 0;

    const renderMarket = (idx) => {
      const m = marketData[idx];
      const yesPrice = m.yes_bid != null ? m.yes_bid : m.last_price;
      const noPrice = m.no_bid != null ? m.no_bid : yesPrice != null ? 100 - yesPrice : null;
      const yesPct = yesPrice != null ? `${yesPrice}\u00a2` : "—";
      const noPct = noPrice != null ? `${noPrice}\u00a2` : "—";
      const vol = m.volume != null ? m.volume.toLocaleString() : "—";
      const closeDate = m.close_time
        ? new Date(m.close_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "—";

      const targetUrl = normalizeKalshiUrl(m.url, m.ticker);

      cardBody.innerHTML = `
        <div class="kalshi-market-item">
          <div class="kalshi-market-title">${escapeHtml(m.title)}</div>
          ${m.subtitle ? `<div class="kalshi-market-subtitle">${escapeHtml(m.subtitle)}</div>` : ""}
          <div class="kalshi-market-odds list">
            <a class="kalshi-odd kalshi-yes" href="${targetUrl}" target="_blank" rel="noopener">
              <span class="kalshi-odd-label">Yes</span>
              <span class="kalshi-odd-multiplier">${m.yes_bid && m.no_bid ? `${(100 / m.yes_bid).toFixed(2)}x` : ""}</span>
              <span class="kalshi-odd-value">${yesPct}</span>
            </a>
            <a class="kalshi-odd kalshi-no" href="${targetUrl}" target="_blank" rel="noopener">
              <span class="kalshi-odd-label">No</span>
              <span class="kalshi-odd-multiplier">${m.no_bid && m.yes_bid ? `${(100 / m.no_bid).toFixed(2)}x` : ""}</span>
              <span class="kalshi-odd-value">${noPct}</span>
            </a>
          </div>
          <div class="kalshi-market-meta">
            <span>Vol: ${vol}</span>
            <span>Closes: ${closeDate}</span>
          </div>
          <a class="kalshi-market-link" href="${targetUrl}" target="_blank" rel="noopener">Trade on Kalshi →</a>
        </div>
      `;

      const cta = card.querySelector(".kalshi-cta");
      if (cta) cta.href = targetUrl;
      if (indexEl) indexEl.textContent = `${idx + 1}/${marketData.length}`;
      if (prevBtn) prevBtn.disabled = idx === 0;
      if (nextBtn) nextBtn.disabled = idx === marketData.length - 1;

      cardBody.classList.remove("kalshi-slide");
      void cardBody.offsetWidth;
      cardBody.classList.add("kalshi-slide");
    };

    if (prevBtn && nextBtn) {
      prevBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (current > 0) {
          current -= 1;
          renderMarket(current);
        }
      });
      nextBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (current < marketData.length - 1) {
          current += 1;
          renderMarket(current);
        }
      });
    }

    renderMarket(current);
    return card;
  }

  function makeDraggable(el, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onMouseMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${startLeft + dx}px`;
      el.style.top = `${startTop + dy}px`;
    };

    const endDrag = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", endDrag);
    };

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", endDrag);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function ensurePills(headlineMap) {
    for (const [headline, el] of headlineMap.entries()) {
      if (headlinePills.has(headline)) continue;
      const pill = createFetchingPill();
      el.style.position = "relative";
      el.appendChild(pill);
      headlinePills.set(headline, pill);
      processedElements.add(el); // prevent duplicate pills on rescans
    }
  }

  function injectResults(results) {
    for (const [headline, pill] of headlinePills.entries()) {
      const markets = results && results[headline];
      updatePill(pill, headline, markets);
    }
  }

  function processPage() {
    const { headlines, headlineMap } = collectHeadlines();
    if (!headlines.length) return;

    ensurePills(headlineMap);

    chrome.runtime.sendMessage({ type: "MATCH_HEADLINES", headlines }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Kalshi extension:", chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok && response.results) {
        injectResults(response.results);
      } else {
        injectResults({});
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (activeCard && !activeCard.contains(e.target) && !e.target.closest(".kalshi-odds-pill")) {
      activeCard.remove();
      activeCard = null;
    }
  });

  processPage();

  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(processPage, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();

// Normalize a Kalshi market URL defensively (used by content and background responses)
function normalizeKalshiUrl(url, ticker) {
  if (url && url.startsWith("http")) return url;
  if (url && url.startsWith("/")) return `https://kalshi.com${url}`;
  if (ticker) return `https://kalshi.com/markets/${ticker}`;
  return "https://kalshi.com/markets";
}
