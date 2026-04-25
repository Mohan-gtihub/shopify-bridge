/* eslint-disable no-undef */
(function () {
  const { $, escapeHtml, fetchJson, toast } = window.App;

  let docsPayload = null;
  // Cache of currently-edited values per endpoint, keyed by anchor id.
  const tryitState = {};

  init().catch((err) => toast(err.message, 'err'));

  async function init() {
    docsPayload = await fetchJson('/api/_docs');
    render();
    $('btn-download').addEventListener('click', downloadSpec);
    const pm = $('btn-postman');
    if (pm) pm.addEventListener('click', downloadPostman);
    const oa = $('btn-openapi');
    if (oa) oa.addEventListener('click', () => window.open('/api/openapi.json', '_blank'));
    setupSearch();
    setupScrollSpy();
  }

  function methodBadge(m) {
    return `<span class="badge method-${m.toLowerCase()}">${escapeHtml(m)}</span>`;
  }
  function tagBadge(t) {
    return `<span class="badge tag">${escapeHtml(t)}</span>`;
  }

  function paramTable(title, obj) {
    if (!obj || !Object.keys(obj).length) return '';
    const rows = Object.entries(obj).map(([k, v]) => `
      <tr>
        <td><code>${escapeHtml(k)}</code></td>
        <td>${escapeHtml(v.type || 'string')}</td>
        <td>${v.required ? '<strong style="color:var(--danger)">required</strong>' : 'optional'}</td>
        <td>${escapeHtml(v.description || '')}</td>
      </tr>
    `).join('');
    return `
      <div class="section-title">${escapeHtml(title)}</div>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function endpointAnchor(ep) {
    return `ep-${ep.method.toLowerCase()}-${ep.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}`;
  }

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

  function curlFor(ep) {
    const base = window.location.origin;
    const url = `${base}${ep.path}`;
    let curl = `curl -X ${ep.method} '${url}' \\\n  -H 'X-Bridge-API-Key: YOUR_BRIDGE_API_KEY'`;
    if (ep.body) {
      curl += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(sampleBody(ep.body), null, 2)}'`;
    }
    return curl;
  }

  function highlightJson(str) {
    if (!str) return '';
    const escaped = String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m) => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:\s*$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
  }

  function render() {
    const eps = docsPayload.endpoints || [];

    const byTag = new Map();
    eps.forEach((ep) => {
      const tags = ep.tags && ep.tags.length ? ep.tags : ['general'];
      const primary = tags[0];
      if (!byTag.has(primary)) byTag.set(primary, []);
      byTag.get(primary).push(ep);
    });

    const sidebar = $('docs-sidebar');
    sidebar.innerHTML = `
      <div class="docs-search"><input type="search" id="docs-search-input" placeholder="Filter endpoints…" /></div>
      ${[...byTag.entries()].map(([tag, list]) => `
        <h4>${escapeHtml(tag)}</h4>
        ${list.map((ep) => `
          <a href="#${endpointAnchor(ep)}" data-anchor="${endpointAnchor(ep)}" data-search="${escapeHtml((ep.path + ' ' + ep.method + ' ' + (ep.summary || '')).toLowerCase())}">
            <span class="m ${ep.method.toLowerCase()}">${escapeHtml(ep.method)}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ep.path)}</span>
          </a>
        `).join('')}
      `).join('')}
    `;

    const main = $('docs-main');
    const intro = `
      <div class="docs-intro">
        <h1>API Reference</h1>
        <p>
          A small bridge over the Shopify Admin GraphQL API. Every endpoint returns JSON,
          accepts JSON, and reports rate-limit usage in the <code>throttle</code> field of every response.
          Authenticate with the <code>X-Bridge-API-Key</code> header.
        </p>
        <div class="quick-actions">
          <a href="index.html#explorer"><button class="small">Open API Explorer</button></a>
          <button class="small muted" id="intro-postman">Download Postman Collection</button>
          <a href="/api/openapi.json" target="_blank"><button class="small muted">View OpenAPI Spec</button></a>
        </div>
        <div class="meta">
          <span><strong>Shop</strong> <code>${escapeHtml(docsPayload.shop || 'unauthenticated')}</code></span>
          <span><strong>Version</strong> <code>${escapeHtml(docsPayload.apiVersion || '')}</code></span>
          <span><strong>Endpoints</strong> ${eps.length}</span>
          <span><strong>Generated</strong> ${escapeHtml(docsPayload.generatedAt)}</span>
        </div>
      </div>
    `;

    const cards = eps.map((ep) => {
      const ex = ep.responseExample;
      const exJson = ex == null ? '' : (typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2));
      const anchor = endpointAnchor(ep);
      return `
        <div class="endpoint-card method-${ep.method.toLowerCase()}" id="${anchor}">
          <button class="copy-curl small ghost" data-method="${escapeHtml(ep.method)}" data-path="${escapeHtml(ep.path)}">Copy cURL</button>
          <div class="ep-head">
            ${methodBadge(ep.method)}
            <span class="path-code">${escapeHtml(ep.path)}</span>
            ${(ep.tags || []).map(tagBadge).join(' ')}
          </div>
          ${ep.summary ? `<p class="summary">${escapeHtml(ep.summary)}</p>` : ''}
          ${ep.description ? `<p class="desc">${escapeHtml(ep.description)}</p>` : ''}
          ${paramTable('Path parameters', ep.params)}
          ${paramTable('Query parameters', ep.query)}
          ${paramTable('Request body', ep.body)}
          ${exJson ? `<div class="section-title">Response example</div><pre>${highlightJson(exJson)}</pre>` : ''}

          <button class="tryit-toggle" data-toggle="${anchor}">▶ Try it</button>
          <div class="tryit-panel" id="tryit-${anchor}" data-anchor="${anchor}">
            ${renderTryitForm(ep)}
          </div>
        </div>
      `;
    }).join('');
    main.innerHTML = intro + cards;

    main.querySelectorAll('.copy-curl').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ep = eps.find((e) => e.method === btn.dataset.method && e.path === btn.dataset.path);
        if (!ep) return;
        navigator.clipboard.writeText(curlFor(ep)).then(() => toast('Copied cURL', 'ok'));
      });
    });

    main.querySelectorAll('.tryit-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const anchor = btn.dataset.toggle;
        const panel = document.getElementById('tryit-' + anchor);
        const open = panel.classList.toggle('open');
        btn.textContent = (open ? '▼' : '▶') + ' Try it';
      });
    });

    main.querySelectorAll('.tryit-panel').forEach((panel) => {
      const anchor = panel.dataset.anchor;
      const ep = eps.find((e) => endpointAnchor(e) === anchor);
      if (!ep) return;
      attachTryit(panel, ep, anchor);
    });

    const ip = $('intro-postman');
    if (ip) ip.addEventListener('click', downloadPostman);
  }

  function renderTryitForm(ep) {
    const params = Object.entries(ep.params || {}).map(([k, def]) => `
      <div class="tryit-row">
        <label>:${escapeHtml(k)}${def.required ? ' *' : ''}</label>
        <input type="text" data-tryit-kind="params" data-tryit-key="${escapeHtml(k)}" placeholder="${escapeHtml(def.description || k)}" />
      </div>
    `).join('');
    const query = Object.entries(ep.query || {}).map(([k, def]) => `
      <div class="tryit-row">
        <label>?${escapeHtml(k)}${def.required ? ' *' : ''}</label>
        <input type="text" data-tryit-kind="query" data-tryit-key="${escapeHtml(k)}" placeholder="${escapeHtml(def.description || '')}" />
      </div>
    `).join('');
    const bodySample = ep.body ? JSON.stringify(sampleBody(ep.body), null, 2) : '';
    const bodyHtml = ep.body ? `
      <div class="tryit-row" style="grid-template-columns:140px 1fr;align-items:start;">
        <label>Body (JSON)</label>
        <textarea data-tryit-body spellcheck="false">${escapeHtml(bodySample)}</textarea>
      </div>
    ` : '';

    return `
      ${params || query || bodyHtml ? '' : '<div style="color:var(--ink-3);font-size:12px;margin-bottom:8px;">No parameters required.</div>'}
      ${params}
      ${query}
      ${bodyHtml}
      <div class="tryit-actions">
        <button class="small" data-tryit-send>Send Request</button>
        <span class="tryit-status" data-tryit-status></span>
      </div>
      <div class="tryit-result" data-tryit-result></div>
    `;
  }

  function attachTryit(panel, ep, anchor) {
    tryitState[anchor] = { params: {}, query: {}, body: '' };
    const st = tryitState[anchor];
    panel.querySelectorAll('input[data-tryit-kind]').forEach((inp) => {
      inp.addEventListener('input', () => { st[inp.dataset.tryitKind][inp.dataset.tryitKey] = inp.value; });
    });
    const ta = panel.querySelector('textarea[data-tryit-body]');
    if (ta) {
      st.body = ta.value;
      ta.addEventListener('input', () => { st.body = ta.value; });
    }
    const sendBtn = panel.querySelector('[data-tryit-send]');
    const statusEl = panel.querySelector('[data-tryit-status]');
    const resultEl = panel.querySelector('[data-tryit-result]');
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      statusEl.textContent = 'Sending…';
      resultEl.innerHTML = '';

      let path = ep.path.replace(/:(\w+)/g, (m, k) => st.params[k] ? encodeURIComponent(st.params[k]) : m);
      const qs = Object.entries(st.query).filter(([_, v]) => v !== '' && v != null)
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
      const url = path + (qs ? '?' + qs : '');

      const headers = {};
      // Pull API key from the explorer/system info if it's been seen in localStorage on the same origin.
      // Otherwise the same-origin browser session covers auth.
      let body;
      if (['POST', 'PUT', 'PATCH'].includes(ep.method)) {
        headers['Content-Type'] = 'application/json';
        body = st.body || JSON.stringify(sampleBody(ep.body));
        try { JSON.parse(body); } catch (e) {
          statusEl.textContent = 'Invalid JSON';
          sendBtn.disabled = false;
          return;
        }
      }

      const start = performance.now();
      let res, text = '', errMsg = null;
      try {
        res = await fetch(url, { method: ep.method, headers, body });
        text = await res.text();
      } catch (err) { errMsg = err.message; }
      const dur = Math.round(performance.now() - start);

      if (errMsg) {
        statusEl.textContent = 'Network error';
        resultEl.innerHTML = `<pre><span style="color:var(--danger)">${escapeHtml(errMsg)}</span></pre>`;
      } else {
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        statusEl.textContent = `${res.status} ${res.statusText} · ${dur}ms · ${(new Blob([text]).size / 1024).toFixed(1)} KB`;
        resultEl.innerHTML = `<pre>${highlightJson(pretty)}</pre>`;
      }
      sendBtn.disabled = false;
    });
  }

  function setupSearch() {
    const inp = $('docs-search-input');
    if (!inp) return;
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      document.querySelectorAll('.docs-sidebar a[data-search]').forEach((a) => {
        a.style.display = !q || a.dataset.search.includes(q) ? '' : 'none';
      });
      document.querySelectorAll('.docs-sidebar h4').forEach((h) => {
        const next = [];
        let n = h.nextElementSibling;
        while (n && n.tagName === 'A') { next.push(n); n = n.nextElementSibling; }
        const anyVisible = next.some((a) => a.style.display !== 'none');
        h.style.display = anyVisible ? '' : 'none';
      });
    });
  }

  function setupScrollSpy() {
    const links = [...document.querySelectorAll('.docs-sidebar a[data-anchor]')];
    if (!links.length) return;
    const map = new Map(links.map((a) => [a.dataset.anchor, a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          links.forEach((a) => a.classList.remove('active'));
          const a = map.get(e.target.id);
          if (a) {
            a.classList.add('active');
            a.scrollIntoView({ block: 'nearest' });
          }
        }
      });
    }, { rootMargin: '-90px 0px -70% 0px', threshold: 0 });
    document.querySelectorAll('.endpoint-card').forEach((c) => io.observe(c));
  }

  function downloadSpec() {
    const blob = new Blob([JSON.stringify(docsPayload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'shopify-bridge-api.json');
  }
  function downloadPostman() {
    const eps = docsPayload.endpoints || [];
    const collection = {
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
        { key: 'baseUrl', value: window.location.origin },
        { key: 'BRIDGE_API_KEY', value: '' },
      ],
      item: eps.map((ep) => ({
        name: ep.summary || (ep.method + ' ' + ep.path),
        request: {
          method: ep.method,
          header: ep.body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
          url: {
            raw: '{{baseUrl}}' + ep.path.replace(/:(\w+)/g, '{{$1}}'),
            host: ['{{baseUrl}}'],
            path: ep.path.split('/').filter(Boolean).map((s) => s.replace(/^:(\w+)$/, '{{$1}}')),
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
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'shopify-bridge.postman_collection.json');
    toast('Postman collection downloaded', 'ok');
  }
  function triggerDownload(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
})();
