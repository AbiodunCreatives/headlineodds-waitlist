
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

  // ── Divergence detection ───────────────────────────────────
  const CONFIDENT_PHRASES = [
    "set to ", "will ", "confirms", "confirmed", "signals", "expected to",
    "poised to", "on track", "heading for", "secures", "seals", "clinches",
    "approved", "approves", "passes ", "passed ", "to sign", "has signed",
    "launches", "announces", "announced", "officially", "prepares to",
    "is set", "guaranteed", "certain to", "mandates", "bans ", "wins ",
    "defeats", "rejects", "sealed", "locked in", "green-lights",
  ];
  const DIVERGE_THRESHOLD = 40; // yes_bid < 40¢ = divergent

  function isDivergent(headline, yesPrice) {
    if (yesPrice == null) return false;
    if (yesPrice >= DIVERGE_THRESHOLD) return false;
    const lower = headline.toLowerCase();
    return CONFIDENT_PHRASES.some(p => lower.includes(p));
  }
  const processedElements = new WeakSet();
  const headlinePills = new Map(); // headline -> pill
  const headlineMarkets = new Map(); // headline -> last good markets
  const headlineHosts = new Map(); // headline -> host element
  let activeCard = null;
  const LOGO_URL = chrome.runtime.getURL("logo.png");
  // Use root icon because only root icons are web-accessible; avoids 404 on fallback
  const FALLBACK_LOGO_URL = chrome.runtime.getURL("icon16.png");

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
    pill.innerHTML = `<span class="kalshi-pill-live" aria-hidden="true"></span><span class="kalshi-pill-text">odds</span>`;
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    pill.setAttribute("aria-live", "polite");
    return pill;
  }

  function updatePill(pill, headline, markets, isError = false) {
    // preserve last successful markets so the pill doesn't vanish on transient misses
    if (markets && markets.length) {
      headlineMarkets.set(headline, markets);
    }
    const data = headlineMarkets.get(headline);

    pill.className = "kalshi-odds-pill";
    pill.removeAttribute("aria-disabled");

    if (!data || !data.length) {
      pill.style.display = "inline-flex";
      pill.classList.add(isError ? "kalshi-pill-error" : "kalshi-pill-empty");
      pill.textContent = isError ? "Kalshi unavailable" : "No market yet";
      pill.title = isError ? "Unable to reach Kalshi right now" : "No matching market found yet";
      pill.onclick = null;
      pill.onkeydown = null;
      pill.setAttribute("aria-disabled", "true");
      return;
    }

    pill.style.display = "inline-flex";

    const topMarket = data[0];
    const yesPrice = topMarket.yes_bid != null ? topMarket.yes_bid : topMarket.last_price;
    const yesLabel = yesPrice != null ? `${yesPrice}¢` : "—";
    const divergent = isDivergent(headline, yesPrice);
    pill._divergent = divergent;
    pill._marketData = data;
    pill._card = null; // force rebuild if data changed

    if (divergent) {
      pill.classList.add("kalshi-pill-diverge");
      pill.innerHTML = `<span class="kalshi-pill-diverge-icon" aria-hidden="true">⚡</span><span class="kalshi-pill-yes">${yesLabel}</span><span class="kalshi-pill-label">yes</span>`;
      pill.title = `⚡ Market disagrees · Yes: ${yesLabel} · Click to see`;
    } else {
      pill.innerHTML = `<span class="kalshi-pill-live" aria-hidden="true"></span><span class="kalshi-pill-yes">${yesLabel}</span><span class="kalshi-pill-label">yes</span>`;
      pill.title = `Yes: ${yesLabel} · Click to see market odds`;
    }
    const openCard = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCard(pill, data, headline);
    };
    pill.onclick = openCard;
    pill.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCard(e);
      }
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
    trapFocus(card);
    const closeBtn = card.querySelector(".kalshi-card-close");
    if (closeBtn) {
      closeBtn.focus({ preventScroll: true });
    }

    activeCard = card;
  }

  function buildCard(pill, marketData, headline) {
    const card = document.createElement("div");
    card.className = "kalshi-market-card";
    card._pill = pill;

    const divergent = pill._divergent;
    card.innerHTML = `
      <div class="kalshi-card-header">
        <div class="kalshi-card-title">
          <img src="${LOGO_URL}" alt="logo" class="kalshi-card-logo-img" />
          <span>ODDS ON THIS STORY</span>
        </div>
        <button class="kalshi-card-close" aria-label="Close">✕</button>
      </div>
      ${divergent ? `<div class="kalshi-diverge-banner"><span>⚡</span><span>Market disagrees with this headline</span></div>` : ""}
      <div class="kalshi-card-body"></div>
      ${marketData.length > 1 ? `
      <div class="kalshi-card-nav">
        <button class="kalshi-nav-btn kalshi-nav-prev" aria-label="Previous market">‹</button>
        <span class="kalshi-card-index"></span>
        <button class="kalshi-nav-btn kalshi-nav-next" aria-label="Next market">›</button>
      </div>` : ""}
      <a class="kalshi-cta" href="${normalizeKalshiUrl(marketData[0].url, marketData[0].ticker, marketData[0].series_ticker || marketData[0].event_ticker)}" target="_blank" rel="noopener">View market</a>
      <a class="kalshi-share-btn" href="#" target="_blank" rel="noopener">𝕏 Share these odds</a>
      <div class="kalshi-powered">Powered by <span>Kalshi</span></div>
    `;
    const logoImg = card.querySelector(".kalshi-card-logo-img");
    if (logoImg) {
      logoImg.addEventListener("error", () => { logoImg.src = FALLBACK_LOGO_URL; }, { once: true });
    }
    // defensive: ensure no pills render inside card
    card.querySelectorAll(".kalshi-odds-pill").forEach((p) => p.remove());

    card.querySelector(".kalshi-card-close").addEventListener("click", (e) => {
      e.stopPropagation();
      card.remove();
      activeCard = null;
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        card.remove();
        activeCard = null;
      }
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
      // volume is in contracts; multiply by price (cents) / 100 to get dollar volume
      const price = m.last_price ?? m.yes_bid ?? 50;
      const vol = m.volume != null
        ? `$${Math.round(m.volume * price / 100).toLocaleString()}`
        : "—";
      const closeDate = m.close_time
        ? new Date(m.close_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "—";

      const targetUrl = normalizeKalshiUrl(
        m.url,
        m.ticker,
        m.series_ticker || m.event_ticker || m.series
      );
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
            <span>Vol: <span class="kalshi-meta-strong">${vol}</span></span>
            <span>Closes: ${closeDate}</span>
          </div>
          <a class="kalshi-market-link" href="${targetUrl}" target="_blank" rel="noopener">Trade on Kalshi →</a>
        </div>
      `;

      const cta = card.querySelector(".kalshi-cta");
      if (cta) cta.href = targetUrl;

      const shareBtn = card.querySelector(".kalshi-share-btn");
      if (shareBtn) {
        const shortHeadline = headline.length > 110 ? headline.slice(0, 107) + "…" : headline;
        const tweetText = `"${shortHeadline}"\n\nMarket says: ${yesPct} yes\n\nvia @headlineodds 🟢\nheadlineodds.fun`;
        shareBtn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
      }

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
      const keyNav = (e) => {
        if (e.key === "ArrowLeft" && current > 0) {
          current -= 1;
          renderMarket(current);
        } else if (e.key === "ArrowRight" && current < marketData.length - 1) {
          current += 1;
          renderMarket(current);
        }
      };
      prevBtn.addEventListener("keydown", keyNav);
      nextBtn.addEventListener("keydown", keyNav);
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

  function pruneRemovedPills() {
    for (const [headline, pill] of headlinePills.entries()) {
      const host = headlineHosts.get(headline) || pill.parentElement;
      if (!host || !host.isConnected || !document.contains(host)) {
        pill.remove();
        headlinePills.delete(headline);
        headlineMarkets.delete(headline);
        headlineHosts.delete(headline);
      }
    }
  }

  function ensurePills(headlineMap) {
    for (const [headline, el] of headlineMap.entries()) {
      if (headlinePills.has(headline)) continue;
      const pill = createFetchingPill();
      el.style.position = "relative";
      el.appendChild(pill);
      pill._host = el;
      headlinePills.set(headline, pill);
      headlineHosts.set(headline, el);
      processedElements.add(el); // prevent duplicate pills on rescans
    }
  }

  function injectResults(results, isError = false) {
    for (const [headline, pill] of headlinePills.entries()) {
      const markets = results && results[headline];
      updatePill(pill, headline, markets, isError);
    }
  }

  function processPage() {
    const { headlines, headlineMap } = collectHeadlines();
    if (!headlines.length) return;

    ensurePills(headlineMap);
    pruneRemovedPills();

    chrome.runtime.sendMessage({ type: "MATCH_HEADLINES", headlines }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Kalshi extension:", chrome.runtime.lastError.message);
        injectResults({}, true); // clear fetching state on error so pills don't hang
        return;
      }
      if (response && response.ok && response.results) {
        injectResults(response.results);
      } else {
        injectResults({}, true);
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (activeCard && !activeCard.contains(e.target) && !e.target.closest(".kalshi-odds-pill")) {
      activeCard.remove();
      activeCard = null;
    }
  });

  // warm cache immediately to cut first-load delay
  chrome.runtime.sendMessage({ type: "WARM_CACHE" }, () => {
    // ignore result
  });

  processPage();

  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(processPage, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });
})();

// Normalize a Kalshi market URL defensively (used by content and background responses)
function normalizeKalshiUrl(url, ticker, seriesTicker) {
  if (url && url.startsWith("http")) return url;
  if (url && url.startsWith("/")) return `https://kalshi.com${url}`;
  if (url && url.includes("/")) return `https://kalshi.com/markets/${url}`;

  // Kalshi uses /markets/{series_ticker} — single segment, redirects to full SEO URL
  const eventSlug = (seriesTicker || "").toString();
  const tickerSlug = (ticker || "").toString();

  if (eventSlug) return `https://kalshi.com/markets/${eventSlug}`;
  if (tickerSlug) return `https://kalshi.com/markets/${tickerSlug}`;
  return "https://kalshi.com/markets";
}

function trapFocus(container) {
  const focusable = Array.from(
    container.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute("disabled"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  container.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}
