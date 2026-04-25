/* eslint-disable no-undef */
(function () {
  const { $, escapeHtml, fetchJson, toast } = window.App;

  let docsPayload = null;

  init().catch(err => toast(err.message, 'err'));

  async function init() {
    docsPayload = await fetchJson('/api/_docs');
    render();
    $('btn-download').addEventListener('click', download);
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
        <td>${v.required ? '<strong>yes</strong>' : 'no'}</td>
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

  function curlFor(ep) {
    const base = window.location.origin || 'http://localhost:3000';
    const url = `${base}${ep.path}`;
    let curl = `curl -X ${ep.method} '${url}'`;
    if (ep.body) {
      const sample = {};
      Object.entries(ep.body).forEach(([k, v]) => {
        sample[k] = v.description ? `<${v.type || 'string'}>` : (v.type || 'string');
      });
      curl += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(sample)}'`;
    }
    return curl;
  }

  function render() {
    const eps = docsPayload.endpoints || [];

    // ---- Sidebar (grouped, with method pill) ----
    const byTag = new Map();
    eps.forEach((ep) => {
      const tags = ep.tags && ep.tags.length ? ep.tags : ['general'];
      const primary = tags[0];
      if (!byTag.has(primary)) byTag.set(primary, []);
      byTag.get(primary).push(ep);
    });
    const sidebar = $('docs-sidebar');
    sidebar.innerHTML = [...byTag.entries()].map(([tag, list]) => `
      <h4>${escapeHtml(tag)}</h4>
      ${list.map(ep => `
        <a href="#${endpointAnchor(ep)}" data-anchor="${endpointAnchor(ep)}">
          <span class="m ${ep.method.toLowerCase()}">${escapeHtml(ep.method)}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ep.path)}</span>
        </a>
      `).join('')}
    `).join('');

    // ---- Main: intro + cards ----
    const main = $('docs-main');
    const intro = `
      <div class="docs-intro">
        <h1>API Reference</h1>
        <p style="color:var(--ink-2);font-size:14px;margin:0 0 12px;max-width:62ch;">
          A small bridge over the Shopify Admin GraphQL API. Every endpoint returns JSON,
          accepts JSON, and reports rate-limit usage in the <code>throttle</code> field of every response.
        </p>
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
      return `
        <div class="endpoint-card method-${ep.method.toLowerCase()}" id="${endpointAnchor(ep)}">
          <button class="copy-curl" data-method="${escapeHtml(ep.method)}" data-path="${escapeHtml(ep.path)}">Copy cURL</button>
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
          ${exJson ? `<div class="section-title">Response example</div><pre><code>${escapeHtml(exJson)}</code></pre>` : ''}
        </div>
      `;
    }).join('');
    main.innerHTML = intro + cards;

    main.querySelectorAll('.copy-curl').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ep = eps.find(e => e.method === btn.dataset.method && e.path === btn.dataset.path);
        if (!ep) return;
        navigator.clipboard.writeText(curlFor(ep)).then(() => toast('Copied cURL'), () => toast('Clipboard blocked', 'err'));
      });
    });
  }

  function setupScrollSpy() {
    const links = [...document.querySelectorAll('.docs-sidebar a[data-anchor]')];
    if (!links.length) return;
    const map = new Map(links.map(a => [a.dataset.anchor, a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          links.forEach(a => a.classList.remove('active'));
          const a = map.get(e.target.id);
          if (a) {
            a.classList.add('active');
            // keep it in sidebar viewport
            a.scrollIntoView({ block: 'nearest' });
          }
        }
      });
    }, { rootMargin: '-90px 0px -70% 0px', threshold: 0 });
    document.querySelectorAll('.endpoint-card').forEach(c => io.observe(c));
  }

  function download() {
    const blob = new Blob([JSON.stringify(docsPayload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shopify-bridge-api.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
})();
