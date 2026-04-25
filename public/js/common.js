/* eslint-disable no-unused-vars */
// Shared front-end utilities. Loaded as a plain script before page-specific JS.

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function qs(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function numericIdFromGid(gid) {
  if (!gid) return '';
  const m = String(gid).match(/\/(\d+)(?:$|\?)/);
  return m ? m[1] : String(gid);
}

function gidFor(type, id) {
  if (typeof id === 'string' && id.startsWith('gid://')) return id;
  return `gid://shopify/${type}/${id}`;
}

function formatMoney(amount, currency) {
  if (amount == null) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return String(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch (_) {
    return `${n.toFixed(2)} ${currency || ''}`.trim();
  }
}

async function fetchJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error('Network error: ' + err.message);
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || (data && data.error)) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    const code = data && data.code;
    const err = new Error(code ? `[${code}] ${msg}` : msg);
    err.status = res.status;
    err.code = code;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

// ---- Throttle bar (shared on every page) ----
let lastThrottle = null;
let lastThrottleAt = 0;

function paintThrottle(currentlyAvailable, maximumAvailable, restoreRate, actualQueryCost) {
  const fill = $('throttle-fill');
  const text = $('throttle-text');
  if (!fill || !text) return;
  if (currentlyAvailable == null || !maximumAvailable) {
    fill.style.width = '0%';
    fill.classList.remove('warn', 'crit');
    text.textContent = '—';
    return;
  }
  const pct = Math.max(0, Math.min(100, (currentlyAvailable / maximumAvailable) * 100));
  fill.style.width = pct.toFixed(1) + '%';
  fill.classList.remove('warn', 'crit');
  if (currentlyAvailable < 100) fill.classList.add('warn');
  if (currentlyAvailable < 50) fill.classList.add('crit');
  const lastCost = actualQueryCost != null ? '  cost ' + actualQueryCost : '';
  text.textContent = `${Math.round(currentlyAvailable)}/${maximumAvailable} (+${restoreRate}/s)${lastCost}`;
}

function renderThrottle(t) {
  if (!t || !t.throttleStatus) { lastThrottle = null; paintThrottle(); return; }
  lastThrottle = t;
  lastThrottleAt = Date.now();
  const ts = t.throttleStatus;
  paintThrottle(ts.currentlyAvailable, ts.maximumAvailable, ts.restoreRate, t.actualQueryCost);
}

setInterval(() => {
  if (!lastThrottle || !lastThrottle.throttleStatus) return;
  const ts = lastThrottle.throttleStatus;
  const elapsed = (Date.now() - lastThrottleAt) / 1000;
  const projected = Math.min(ts.maximumAvailable, ts.currentlyAvailable + ts.restoreRate * elapsed);
  paintThrottle(projected, ts.maximumAvailable, ts.restoreRate, lastThrottle.actualQueryCost);
}, 1000);

async function refreshThrottle() {
  try {
    const d = await fetchJson('/api/throttle');
    renderThrottle(d.throttle);
  } catch (_) { /* silent */ }
}
refreshThrottle();
setInterval(refreshThrottle, 3000);

// ---- Status box helpers ----
function setStatus(el, type, message) {
  if (!el) return;
  el.className = 'status ' + (type === 'ok' ? 'ok' : type === 'info' ? 'info' : 'err');
  el.textContent = message;
}
function clearStatus(el) {
  if (!el) return;
  el.className = 'status';
  el.textContent = '';
}

// ---- Toast (top-level) ----
function toast(message, type) {
  let el = document.getElementById('global-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast ' + (type === 'err' ? 'err' : 'ok') + ' show';
  el.textContent = message;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.remove('show'); }, 3500);
}

// ---- Header shop info (active on every page) ----
async function loadShopHeader() {
  const target = document.getElementById('shop-name');
  const cur = document.getElementById('shop-currency');
  const conn = document.getElementById('conn');
  if (!target && !cur && !conn) return;

  try {
    const status = await fetchJson('/api/status');
    
    if (status.connected) {
      // Token is healthy
      const d = await fetchJson('/api/admin/shop');
      if (target && d.shop && d.shop.name) target.textContent = d.shop.name;
      if (cur && d.shop && d.shop.currencyCode) cur.textContent = d.shop.currencyCode;
      if (d.shop && d.shop.currencyCode) window.__SHOP_CURRENCY = d.shop.currencyCode;
      
      const baseUrlEl = document.getElementById('info-base-url');
      const apiKeyEl = document.getElementById('info-api-key');
      const copyBtn = document.getElementById('btn-copy-key');
      if (baseUrlEl) baseUrlEl.textContent = status.baseUrl;
      if (apiKeyEl) {
        apiKeyEl.setAttribute('data-value', status.bridgeApiKey || '');
        // Keep the hidden mask by default
        apiKeyEl.textContent = '••••••';
        if (copyBtn) copyBtn.onclick = () => {
          navigator.clipboard.writeText(status.bridgeApiKey);
          toast('API Key copied to clipboard', 'ok');
        };
      }

      conn.className = 'conn';
      conn.textContent = 'Connected';
      conn.onclick = () => toast(`Connected to ${status.shop}`, 'ok');
      conn.title = `Last fetched: ${new Date(status.fetchedAt).toLocaleString()}`;
    } else {
      // Token is invalid or missing
      throw new Error(status.reason || 'DISCONNECTED');
    }
  } catch (err) {
    if (target) target.textContent = 're-auth required';
    conn.className = 'conn off btn-reauth';
    conn.textContent = 'Reconnect to Shopify';
    conn.onclick = () => {
      window.location.href = '/auth';
    };
    conn.title = err.message === 'INVALID_TOKEN' 
      ? 'Your Shopify session has expired. Click to refresh.' 
      : 'No active Shopify connection found.';
  }
}
loadShopHeader();

// expose for page scripts
window.App = {
  $, escapeHtml, fetchJson, qs, debounce, numericIdFromGid, gidFor, formatMoney,
  setStatus, clearStatus, toast, renderThrottle,
};
