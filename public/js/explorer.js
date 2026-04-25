/* eslint-disable no-undef */
/**
 * Shopify Bridge — API Explorer
 * A Postman-lite developer console for the Bridge API.
 *
 * Features:
 *  - Endpoint sidebar with grouping by tag + live filter
 *  - Structured inputs for path params, query params, body
 *  - Send-as-JSON request execution with timing
 *  - Status pill, latency, payload size, response headers tab
 *  - cURL / JS fetch / Python requests / Node SDK snippet generation
 *  - Per-tab request history (localStorage)
 *  - Environment switcher (local / prod / custom) with persistence
 *  - Postman v2.1 collection download
 */
(function () {
  const { $, escapeHtml, fetchJson, toast } = window.App;

  const LS_ENV = 'bridge.env';
  const LS_CUSTOM_BASE = 'bridge.customBase';
  const LS_HISTORY = 'bridge.history';
  const LS_SNIPPET_LANG = 'bridge.snippetLang';
  const LS_REQ_VALUES = 'bridge.reqValues';

  const state = {
    endpoints: [],
    selected: null,
    activeReqTab: 'params',
    activeResTab: 'body',
    snippetLang: localStorage.getItem(LS_SNIPPET_LANG) || 'curl',
    response: null,
    history: loadHistory(),
    env: localStorage.getItem(LS_ENV) || 'local',
    bases: {
      local: window.location.origin,
      prod: 'https://YOUR-PROD-HOST',
      custom: localStorage.getItem(LS_CUSTOM_BASE) || window.location.origin,
    },
    apiKey: '',
    reqValues: loadReqValues(), // { [endpointKey]: { params:{}, query:{}, body:string } }
  };

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); }
    catch (_) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(state.history.slice(0, 30))); }
    catch (_) { }
  }
  function loadReqValues() {
    try { return JSON.parse(localStorage.getItem(LS_REQ_VALUES) || '{}'); }
    catch (_) { return {}; }
  }
  function saveReqValues() {
    try { localStorage.setItem(LS_REQ_VALUES, JSON.stringify(state.reqValues)); }
    catch (_) { }
  }
  function endpointKey(ep) { return ep.method + ' ' + ep.path; }
  function getReqValues(ep) {
    const k = endpointKey(ep);
    if (!state.reqValues[k]) state.reqValues[k] = { params: {}, query: {}, body: '' };
    return state.reqValues[k];
  }

  function init() {
    setupTabSwitching();
    setupEnvSwitcher();
    setupKeyControls();
    setupPostmanDownload();
    setupSearch();
    loadEndpoints();
  }

  // ---- Tab switching (top-level) ----
  function setupTabSwitching() {
    const tabs = document.querySelectorAll('.tab[data-tab]');
    const views = document.querySelectorAll('.view');
    tabs.forEach((t) => {
      t.addEventListener('click', () => {
        const target = t.getAttribute('data-tab');
        tabs.forEach((tb) => tb.classList.toggle('active', tb === t));
        views.forEach((v) => {
          const show = v.id === 'view-' + target;
          v.style.display = show ? 'grid' : 'none';
          v.classList.toggle('active', show);
        });
        if (target === 'explorer' && !state.endpoints.length) loadEndpoints();
      });
    });
  }

  // ---- Env switcher ----
  function setupEnvSwitcher() {
    const sel = $('env-select');
    if (!sel) return;
    sel.value = state.env;
    paintBase();
    sel.addEventListener('change', () => {
      state.env = sel.value;
      if (state.env === 'custom') {
        const v = prompt('Custom base URL:', state.bases.custom);
        if (v) {
          state.bases.custom = v.replace(/\/$/, '');
          localStorage.setItem(LS_CUSTOM_BASE, state.bases.custom);
        }
      }
      localStorage.setItem(LS_ENV, state.env);
      paintBase();
      if (state.selected) renderWorkspace();
    });
  }
  function baseUrl() { return state.bases[state.env] || state.bases.local; }
  function paintBase() {
    const el = $('info-base-url');
    if (el) el.textContent = baseUrl();
  }

  // ---- API key reveal/copy ----
  function setupKeyControls() {
    const btnEye = $('btn-toggle-eye');
    const btnCopy = $('btn-copy-key');
    if (btnEye) btnEye.addEventListener('click', toggleKeyVisibility);
    if (btnCopy) btnCopy.addEventListener('click', () => {
      const v = $('info-api-key').getAttribute('data-value');
      if (!v) return toast('No API key configured', 'err');
      navigator.clipboard.writeText(v).then(() => toast('API key copied', 'ok'));
    });
    // Watch for value updates from common.js
    const obs = new MutationObserver(() => {
      state.apiKey = $('info-api-key').getAttribute('data-value') || '';
      if (state.selected) renderSnippet();
    });
    obs.observe($('info-api-key'), { attributes: true, attributeFilter: ['data-value'] });
  }
  function toggleKeyVisibility() {
    const el = $('info-api-key');
    const btn = $('btn-toggle-eye');
    if (el.getAttribute('data-hidden') === 'true') {
      el.textContent = el.getAttribute('data-value') || '(none)';
      el.setAttribute('data-hidden', 'false');
      btn.textContent = 'Hide';
    } else {
      el.textContent = '••••••••••••••••';
      el.setAttribute('data-hidden', 'true');
      btn.textContent = 'Show';
    }
  }

  // ---- Postman collection download ----
  function setupPostmanDownload() {
    const btn = $('btn-postman');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const collection = buildPostmanCollection();
      const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shopify-bridge.postman_collection.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Postman collection downloaded', 'ok');
    });
  }

  function buildPostmanCollection() {
    return {
      info: {
        name: 'Shopify Bridge API',
        _postman_id: 'shopify-bridge-' + Date.now(),
        description: 'Auto-generated from /api/_docs',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      auth: {
        type: 'apikey',
        apikey: [
          { key: 'key', value: 'X-Bridge-API-Key', type: 'string' },
          { key: 'value', value: '{{BRIDGE_API_KEY}}', type: 'string' },
          { key: 'in', value: 'header', type: 'string' },
        ],
      },
      variable: [
        { key: 'baseUrl', value: baseUrl() },
        { key: 'BRIDGE_API_KEY', value: '' },
      ],
      item: state.endpoints.map((ep) => ({
        name: ep.summary || (ep.method + ' ' + ep.path),
        request: {
          method: ep.method,
          header: ep.body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
          url: {
            raw: '{{baseUrl}}' + ep.path.replace(/:(\w+)/g, '{{$1}}'),
            host: ['{{baseUrl}}'],
            path: ep.path.split('/').filter(Boolean).map(s => s.replace(/^:(\w+)$/, '{{$1}}')),
            query: Object.entries(ep.query || {}).map(([k, v]) => ({
              key: k, value: '', description: v.description || '', disabled: !v.required,
            })),
          },
          body: ep.body ? {
            mode: 'raw',
            raw: JSON.stringify(sampleBody(ep.body), null, 2),
            options: { raw: { language: 'json' } },
          } : undefined,
          description: ep.description || ep.summary || '',
        },
        response: [],
      })),
    };
  }

  // ---- Search ----
  function setupSearch() {
    const inp = $('exp-search-input');
    if (!inp) return;
    inp.addEventListener('input', () => renderEndpointList(inp.value.trim().toLowerCase()));
  }

  // ---- Load endpoints from /api/_docs ----
  async function loadEndpoints() {
    const list = $('exp-list');
    if (!list) return;
    try {
      const data = await fetchJson('/api/_docs');
      state.endpoints = data.endpoints || [];
      renderEndpointList('');
    } catch (err) {
      list.innerHTML = `<div class="status err">Failed to load spec: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderEndpointList(filter) {
    const list = $('exp-list');
    if (!list) return;
    const items = state.endpoints.filter((ep) => {
      if (!filter) return true;
      return (ep.path + ' ' + ep.method + ' ' + (ep.summary || '') + ' ' + (ep.tags || []).join(' '))
        .toLowerCase().includes(filter);
    });
    if (!items.length) {
      list.innerHTML = '<div class="empty">No endpoints match.</div>';
      return;
    }
    const groups = new Map();
    items.forEach((ep) => {
      const tag = (ep.tags && ep.tags[0]) || 'other';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(ep);
    });
    const html = [...groups.entries()].map(([tag, eps]) => {
      const rows = eps.map((ep) => {
        const isActive = state.selected && endpointKey(state.selected) === endpointKey(ep);
        return `<div class="exp-item ${isActive ? 'active' : ''}" data-key="${escapeHtml(endpointKey(ep))}">
          <span class="m ${ep.method.toLowerCase()}">${escapeHtml(ep.method)}</span>
          <span class="p" title="${escapeHtml(ep.path)}">${escapeHtml(ep.path)}</span>
        </div>`;
      }).join('');
      return `<div class="group-label">${escapeHtml(tag)}</div>${rows}`;
    }).join('');
    list.innerHTML = html;
    list.querySelectorAll('.exp-item').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-key');
        const ep = state.endpoints.find((e) => endpointKey(e) === key);
        if (ep) selectEndpoint(ep);
      });
    });
  }

  function selectEndpoint(ep) {
    state.selected = ep;
    state.response = null;
    state.activeReqTab = ep.body ? 'body' : (ep.params ? 'params' : (ep.query ? 'query' : 'params'));
    document.querySelectorAll('.exp-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-key') === endpointKey(ep));
    });
    renderWorkspace();
  }

  // ---- Workspace render ----
  function renderWorkspace() {
    const ws = $('exp-workspace');
    const ep = state.selected;
    if (!ep) {
      ws.innerHTML = '<div class="panel"><div class="loading">Select an endpoint from the left to begin.</div></div>';
      return;
    }
    const m = ep.method.toLowerCase();
    const paramsCount = ep.params ? Object.keys(ep.params).length : 0;
    const queryCount = ep.query ? Object.keys(ep.query).length : 0;
    const hasBody = !!ep.body;
    const vals = getReqValues(ep);

    ws.innerHTML = `
      <div class="request-builder">
        <div class="req-bar">
          <div class="method-pill ${m}">${escapeHtml(ep.method)}</div>
          <div class="url-display" id="req-url"></div>
          <button class="send-btn" id="btn-send">Send</button>
        </div>

        <div class="req-tabs">
          ${paramsCount ? `<button class="req-tab ${state.activeReqTab === 'params' ? 'active' : ''}" data-rtab="params">Path Params <span class="count">${paramsCount}</span></button>` : ''}
          ${queryCount ? `<button class="req-tab ${state.activeReqTab === 'query' ? 'active' : ''}" data-rtab="query">Query <span class="count">${queryCount}</span></button>` : ''}
          ${hasBody ? `<button class="req-tab ${state.activeReqTab === 'body' ? 'active' : ''}" data-rtab="body">Body</button>` : ''}
          <button class="req-tab ${state.activeReqTab === 'headers' ? 'active' : ''}" data-rtab="headers">Headers</button>
          <button class="req-tab ${state.activeReqTab === 'snippet' ? 'active' : ''}" data-rtab="snippet">Snippet</button>
          <button class="req-tab ${state.activeReqTab === 'docs' ? 'active' : ''}" data-rtab="docs">Docs</button>
        </div>

        ${paramsCount ? `<div class="req-panel ${state.activeReqTab === 'params' ? 'active' : ''}" data-rpanel="params">${renderKvPanel(ep.params, vals.params, 'params')}</div>` : ''}
        ${queryCount ? `<div class="req-panel ${state.activeReqTab === 'query' ? 'active' : ''}" data-rpanel="query">${renderKvPanel(ep.query, vals.query, 'query')}</div>` : ''}
        ${hasBody ? `<div class="req-panel ${state.activeReqTab === 'body' ? 'active' : ''}" data-rpanel="body">${renderBodyPanel(ep, vals)}</div>` : ''}
        <div class="req-panel ${state.activeReqTab === 'headers' ? 'active' : ''}" data-rpanel="headers">${renderHeadersPanel()}</div>
        <div class="req-panel ${state.activeReqTab === 'snippet' ? 'active' : ''}" data-rpanel="snippet">${renderSnippetPanel()}</div>
        <div class="req-panel ${state.activeReqTab === 'docs' ? 'active' : ''}" data-rpanel="docs">${renderDocsPanel(ep)}</div>
      </div>

      <div class="response-panel" id="response-panel">
        ${renderResponse()}
      </div>

      ${state.history.length ? `
      <div class="panel">
        <h2>Recent Requests</h2>
        <div class="history-list" id="history-list">
          ${state.history.slice(0, 12).map((h, i) => `
            <div class="history-item" data-hidx="${i}">
              <span class="m ${h.method.toLowerCase()}">${escapeHtml(h.method)}</span>
              <span class="h-status s${String(h.status)[0]}">${h.status}</span>
              <span class="h-path">${escapeHtml(h.path)}</span>
              <span class="h-time">${h.duration}ms</span>
              <span class="h-time">${timeAgo(h.ts)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}
    `;

    paintUrl();
    attachWorkspaceEvents(ep);
    renderSnippet();
  }

  function renderKvPanel(schema, values, kind) {
    const rows = Object.entries(schema).map(([key, def]) => {
      const v = values[key] != null ? values[key] : '';
      return `
        <div class="kv-row" data-kv-row="${escapeHtml(key)}">
          <div class="kv-label">${escapeHtml(key)}${def.required ? '<span class="kv-required">*</span>' : ''}<span class="kv-type">${escapeHtml(def.type || 'string')}</span></div>
          <input type="text" class="kv-input" data-kv-key="${escapeHtml(key)}" data-kv-kind="${escapeHtml(kind)}" value="${escapeHtml(String(v))}" placeholder="${escapeHtml(def.required ? 'required' : 'optional')}" />
          <div class="kv-desc">${escapeHtml(def.description || '')}</div>
        </div>
      `;
    }).join('');
    return `<div class="kv-grid">${rows}</div>`;
  }

  function renderBodyPanel(ep, vals) {
    const sample = vals.body || JSON.stringify(sampleBody(ep.body), null, 2);
    return `
      <div class="body-toolbar">
        <span class="body-info">application/json</span>
        <button class="small ghost" id="btn-body-format">Format</button>
        <button class="small ghost" id="btn-body-sample">Reset to sample</button>
      </div>
      <div class="body-editor">
        <textarea id="req-body" spellcheck="false">${escapeHtml(sample)}</textarea>
      </div>
    `;
  }

  function renderHeadersPanel() {
    const key = state.apiKey || '<your key>';
    return `
      <div class="kv-grid">
        <div class="kv-row">
          <div class="kv-label">X-Bridge-API-Key<span class="kv-type">string</span></div>
          <input type="text" value="${escapeHtml(key)}" readonly />
          <div class="kv-desc">Auto-injected from session config</div>
        </div>
        <div class="kv-row">
          <div class="kv-label">Content-Type<span class="kv-type">string</span></div>
          <input type="text" value="application/json" readonly />
          <div class="kv-desc">Set automatically for POST/PUT/PATCH</div>
        </div>
      </div>
    `;
  }

  function renderSnippetPanel() {
    const langs = [
      ['curl', 'cURL'],
      ['fetch', 'JS fetch'],
      ['node', 'Node axios'],
      ['python', 'Python'],
    ];
    return `
      <div class="snippet-tabs">
        ${langs.map(([id, label]) => `
          <button class="snippet-tab ${state.snippetLang === id ? 'active' : ''}" data-lang="${id}">${label}</button>
        `).join('')}
      </div>
      <div class="snippet-block">
        <button class="copy-btn ghost small" id="btn-copy-snippet">Copy</button>
        <pre id="snippet-code">…</pre>
      </div>
    `;
  }

  function renderDocsPanel(ep) {
    const tags = (ep.tags || []).map((t) => `<span class="badge tag">${escapeHtml(t)}</span>`).join(' ');
    return `
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${ep.summary ? `<div style="font-size:14px;color:var(--ink);">${escapeHtml(ep.summary)}</div>` : ''}
        ${ep.description ? `<div style="font-size:13px;color:var(--ink-2);">${escapeHtml(ep.description)}</div>` : ''}
        <div>${tags}</div>
        ${ep.responseExample ? `
          <div class="section-title" style="margin-top:8px;color:var(--ink-3);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">Example response</div>
          <pre>${highlightJson(typeof ep.responseExample === 'string' ? ep.responseExample : JSON.stringify(ep.responseExample, null, 2))}</pre>
        ` : ''}
      </div>
    `;
  }

  function renderResponse() {
    if (!state.response) {
      return `<div class="response-body"><div class="response-empty">No response yet — click <strong>Send</strong> to execute the request.</div></div>`;
    }
    const r = state.response;
    const sClass = 's' + String(r.status)[0];
    const sizeKb = (r.size / 1024).toFixed(1);
    const headersRows = Object.entries(r.headers).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');
    const bodyHtml = r.error
      ? `<pre><span style="color:var(--danger)">${escapeHtml(r.error)}</span></pre>`
      : `<pre>${highlightJson(r.bodyText)}</pre>`;

    return `
      <div class="response-header">
        <span class="status-pill ${sClass}">${r.status} ${escapeHtml(r.statusText || '')}</span>
        <span class="meta-stat"><span class="label">Time</span> ${r.duration}ms</span>
        <span class="meta-stat"><span class="label">Size</span> ${sizeKb} KB</span>
        <div class="actions">
          <button class="small ghost" id="btn-copy-response">Copy JSON</button>
          <button class="small ghost" id="btn-download-response">Download</button>
        </div>
      </div>
      <div class="response-tabs">
        <button class="req-tab ${state.activeResTab === 'body' ? 'active' : ''}" data-restab="body">Body</button>
        <button class="req-tab ${state.activeResTab === 'headers' ? 'active' : ''}" data-restab="headers">Headers <span class="count">${Object.keys(r.headers).length}</span></button>
      </div>
      <div class="response-body">
        ${state.activeResTab === 'body' ? bodyHtml
        : `<table class="headers-table">${headersRows || '<tr><td colspan=2 class=loading>No headers</td></tr>'}</table>`}
      </div>
    `;
  }

  // ---- Event wiring ----
  function attachWorkspaceEvents(ep) {
    // Req tabs
    document.querySelectorAll('.req-tab[data-rtab]').forEach((b) => {
      b.addEventListener('click', () => {
        state.activeReqTab = b.dataset.rtab;
        document.querySelectorAll('.req-tab[data-rtab]').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelectorAll('.req-panel[data-rpanel]').forEach((p) => p.classList.toggle('active', p.dataset.rpanel === state.activeReqTab));
        if (state.activeReqTab === 'snippet') renderSnippet();
      });
    });
    // KV inputs
    document.querySelectorAll('.kv-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const kind = inp.dataset.kvKind; const key = inp.dataset.kvKey;
        const vals = getReqValues(ep);
        vals[kind][key] = inp.value;
        saveReqValues();
        paintUrl();
        renderSnippet();
      });
    });
    // Body
    const ta = $('req-body');
    if (ta) {
      ta.addEventListener('input', () => {
        getReqValues(ep).body = ta.value;
        saveReqValues();
        renderSnippet();
      });
    }
    const fmtBtn = $('btn-body-format');
    if (fmtBtn) fmtBtn.addEventListener('click', () => {
      try {
        const obj = JSON.parse(ta.value);
        ta.value = JSON.stringify(obj, null, 2);
        getReqValues(ep).body = ta.value;
        saveReqValues();
        toast('Formatted', 'ok');
        renderSnippet();
      } catch (e) { toast('Invalid JSON', 'err'); }
    });
    const sampBtn = $('btn-body-sample');
    if (sampBtn) sampBtn.addEventListener('click', () => {
      ta.value = JSON.stringify(sampleBody(ep.body), null, 2);
      getReqValues(ep).body = ta.value;
      saveReqValues();
      renderSnippet();
    });
    // Snippet language
    document.querySelectorAll('.snippet-tab').forEach((b) => {
      b.addEventListener('click', () => {
        state.snippetLang = b.dataset.lang;
        localStorage.setItem(LS_SNIPPET_LANG, state.snippetLang);
        document.querySelectorAll('.snippet-tab').forEach((x) => x.classList.toggle('active', x === b));
        renderSnippet();
      });
    });
    // Copy snippet
    const cs = $('btn-copy-snippet');
    if (cs) cs.addEventListener('click', () => {
      navigator.clipboard.writeText($('snippet-code').textContent);
      toast('Snippet copied', 'ok');
    });
    // Send
    $('btn-send').addEventListener('click', () => sendRequest(ep));
    // History clicks
    document.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = +el.dataset.hidx;
        const h = state.history[idx];
        if (!h) return;
        const target = state.endpoints.find((e) => e.method === h.method && e.path === h.epPath);
        if (target) selectEndpoint(target);
      });
    });
    // Response tabs / copy / download
    document.querySelectorAll('.req-tab[data-restab]').forEach((b) => {
      b.addEventListener('click', () => {
        state.activeResTab = b.dataset.restab;
        $('response-panel').innerHTML = renderResponse();
        attachResponseEvents();
      });
    });
    attachResponseEvents();
  }

  function attachResponseEvents() {
    const cr = $('btn-copy-response');
    if (cr) cr.addEventListener('click', () => {
      navigator.clipboard.writeText(state.response.bodyText);
      toast('Response copied', 'ok');
    });
    const dr = $('btn-download-response');
    if (dr) dr.addEventListener('click', () => {
      const blob = new Blob([state.response.bodyText], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'response-' + Date.now() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    document.querySelectorAll('.req-tab[data-restab]').forEach((b) => {
      b.addEventListener('click', () => {
        state.activeResTab = b.dataset.restab;
        $('response-panel').innerHTML = renderResponse();
        attachResponseEvents();
      });
    });
  }

  // ---- URL painting ----
  function paintUrl() {
    const ep = state.selected; if (!ep) return;
    const vals = getReqValues(ep);
    let path = ep.path;
    path = path.replace(/:(\w+)/g, (_m, k) => {
      const v = vals.params[k];
      if (v) return encodeURIComponent(v);
      return `<span class="path-var">:${k}</span>`;
    });
    const qs = buildQueryString(vals.query);
    const target = $('req-url');
    if (target) target.innerHTML = `<span class="base">${escapeHtml(baseUrl())}</span>${path}${qs ? '?' + escapeHtml(qs) : ''}`;
  }

  function buildQueryString(qObj) {
    const parts = [];
    Object.entries(qObj || {}).forEach(([k, v]) => {
      if (v === '' || v == null) return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.join('&');
  }

  function buildExecutableUrl(ep, vals, opts = {}) {
    let path = ep.path.replace(/:(\w+)/g, (m, k) => vals.params[k] ? encodeURIComponent(vals.params[k]) : m);
    const qs = buildQueryString(vals.query);
    const base = opts.absolute === false ? '' : baseUrl();
    return base + path + (qs ? '?' + qs : '');
  }

  // ---- Send ----
  async function sendRequest(ep) {
    const btn = $('btn-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    const vals = getReqValues(ep);

    // Validate path params
    const missing = Object.entries(ep.params || {}).filter(([k, def]) => def.required && !vals.params[k]).map(([k]) => k);
    if (missing.length) {
      toast('Missing required path params: ' + missing.join(', '), 'err');
      btn.disabled = false; btn.textContent = 'Send';
      return;
    }

    const url = buildExecutableUrl(ep, vals, { absolute: false });
    const headers = { 'X-Bridge-API-Key': state.apiKey };
    let body;
    if (['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      headers['Content-Type'] = 'application/json';
      body = vals.body || JSON.stringify(sampleBody(ep.body));
      try { JSON.parse(body); } catch (e) {
        toast('Body is not valid JSON', 'err');
        btn.disabled = false; btn.textContent = 'Send';
        return;
      }
    }

    const start = performance.now();
    let res, text = '', errMsg = null, respHeaders = {};
    try {
      res = await fetch(url, { method: ep.method, headers, body });
      respHeaders = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      text = await res.text();
    } catch (err) {
      errMsg = err.message;
    }
    const duration = Math.round(performance.now() - start);

    // Pretty-print JSON if possible
    let bodyText = text;
    if (text) {
      try { bodyText = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { }
    }

    state.response = {
      status: res ? res.status : 0,
      statusText: res ? res.statusText : 'Network error',
      headers: respHeaders,
      bodyText,
      size: new Blob([text || '']).size,
      duration,
      error: errMsg,
    };

    state.history.unshift({
      ts: Date.now(),
      method: ep.method,
      path: url,
      epPath: ep.path,
      status: state.response.status,
      duration,
    });
    saveHistory();

    btn.disabled = false; btn.textContent = 'Send';
    renderWorkspace();
    toast(errMsg ? 'Network error' : `${state.response.status} ${state.response.statusText}`, errMsg || state.response.status >= 400 ? 'err' : 'ok');
  }

  // ---- Snippet generation ----
  function renderSnippet() {
    const ep = state.selected; if (!ep) return;
    const codeEl = $('snippet-code');
    if (!codeEl) return;
    const vals = getReqValues(ep);
    const url = buildExecutableUrl(ep, vals, { absolute: true });
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(ep.method);
    const bodyStr = hasBody ? (vals.body || JSON.stringify(sampleBody(ep.body), null, 2)) : null;
    const key = state.apiKey || 'YOUR_BRIDGE_API_KEY';

    let code;
    switch (state.snippetLang) {
      case 'fetch': code = snippetFetch(ep, url, key, bodyStr); break;
      case 'node': code = snippetNode(ep, url, key, bodyStr); break;
      case 'python': code = snippetPython(ep, url, key, bodyStr); break;
      default: code = snippetCurl(ep, url, key, bodyStr);
    }
    codeEl.textContent = code;
  }

  function snippetCurl(ep, url, key, body) {
    let s = `curl -X ${ep.method} '${url}' \\\n  -H 'X-Bridge-API-Key: ${key}'`;
    if (body) s += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
    return s;
  }
  function snippetFetch(ep, url, key, body) {
    const opts = [`  method: '${ep.method}'`, `  headers: {\n    'X-Bridge-API-Key': '${key}'${body ? ",\n    'Content-Type': 'application/json'" : ''}\n  }`];
    if (body) opts.push(`  body: JSON.stringify(${body})`);
    return `const res = await fetch('${url}', {\n${opts.join(',\n')}\n});\nconst data = await res.json();\nconsole.log(data);`;
  }
  function snippetNode(ep, url, key, body) {
    const cfg = [`  method: '${ep.method}'`, `  url: '${url}'`, `  headers: { 'X-Bridge-API-Key': '${key}'${body ? ", 'Content-Type': 'application/json'" : ''} }`];
    if (body) cfg.push(`  data: ${body}`);
    return `import axios from 'axios';\n\nconst { data } = await axios({\n${cfg.join(',\n')}\n});\nconsole.log(data);`;
  }
  function snippetPython(ep, url, key, body) {
    const args = [`'${url}'`, `headers={'X-Bridge-API-Key': '${key}'}`];
    if (body) args.push(`json=${pyDict(body)}`);
    return `import requests\n\nres = requests.${ep.method.toLowerCase()}(${args.join(', ')})\nprint(res.status_code, res.json())`;
  }
  function pyDict(jsonStr) {
    // crude JSON->Python literal: bool/null
    return jsonStr.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None');
  }

  // ---- Sample body builder ----
  function sampleBody(schema) {
    if (!schema) return {};
    const out = {};
    Object.entries(schema).forEach(([k, v]) => {
      const t = (v.type || 'string').toLowerCase();
      if (t === 'integer' || t === 'number') out[k] = 0;
      else if (t === 'boolean') out[k] = false;
      else if (t === 'array') out[k] = [];
      else if (t === 'object') out[k] = {};
      else out[k] = v.description ? `<${t}>` : '';
    });
    return out;
  }

  // ---- JSON syntax highlight ----
  function highlightJson(str) {
    if (!str) return '';
    const escaped = String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m) => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  init();
})();
