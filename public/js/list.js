/* eslint-disable no-undef */
(function () {
  const { $, escapeHtml, fetchJson, debounce, numericIdFromGid, formatMoney, toast, renderThrottle } = window.App;

  // ---- Tabs ----
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + id));
      if (id === 'analytics') refreshAnalytics();
    });
  });

  // ---- Products list ----
  const state = {
    cursors: [],            // stack of "after" cursors per visited page
    afterCursor: null,
    pageSize: 25,
    sortKey: 'UPDATED_AT',
    reverse: true,
    filters: { query: '', status: '', vendor: '', productType: '', tag: '' },
    selected: new Set(),
    pageInfo: null,
    products: [],
  };

  function buildQuery() {
    const params = new URLSearchParams();
    const f = state.filters;
    if (f.query) params.set('query', f.query);
    if (f.status) params.set('status', f.status);
    if (f.vendor) params.set('vendor', f.vendor);
    if (f.productType) params.set('productType', f.productType);
    if (f.tag) params.set('tag', f.tag);
    params.set('first', String(state.pageSize));
    params.set('sortKey', state.sortKey);
    params.set('reverse', String(state.reverse));
    if (state.afterCursor) params.set('after', state.afterCursor);
    return params.toString();
  }

  function priceRange(p) {
    if (!p.priceRangeV2) return '—';
    const min = p.priceRangeV2.minVariantPrice;
    const max = p.priceRangeV2.maxVariantPrice;
    if (!min) return '—';
    const cur = min.currencyCode;
    if (max && max.amount !== min.amount) {
      return `${formatMoney(min.amount, cur)} – ${formatMoney(max.amount, cur)}`;
    }
    return formatMoney(min.amount, cur);
  }

  function statusBadge(s) {
    const cls = (s || '').toLowerCase();
    return `<span class="badge ${escapeHtml(cls)}">${escapeHtml(s || '—')}</span>`;
  }

  function renderProducts() {
    const wrap = $('products-table-wrap');
    if (!state.products.length) {
      wrap.innerHTML = '<div class="empty">No products match these filters.</div>';
      return;
    }
    const rows = state.products.map((p) => {
      const numId = numericIdFromGid(p.id);
      const img = p.featuredImage && p.featuredImage.url;
      const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '—';
      return `
        <tr>
          <td><input type="checkbox" class="row-select" data-id="${escapeHtml(p.id)}" ${state.selected.has(p.id) ? 'checked' : ''}></td>
          <td class="thumb">${img ? `<img src="${escapeHtml(img)}" alt="">` : ''}</td>
          <td><a href="product.html?id=${encodeURIComponent(numId)}">${escapeHtml(p.title || '(untitled)')}</a></td>
          <td>${statusBadge(p.status)}</td>
          <td class="num">${p.totalInventory == null ? '—' : p.totalInventory}</td>
          <td>${escapeHtml(p.vendor || '—')}</td>
          <td>${escapeHtml(p.productType || '—')}</td>
          <td>${priceRange(p)}</td>
          <td>${escapeHtml(updated)}</td>
        </tr>
      `;
    }).join('');
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="select-all"></th>
            <th></th>
            <th>Title</th>
            <th>Status</th>
            <th>Inv</th>
            <th>Vendor</th>
            <th>Type</th>
            <th>Price</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    wrap.querySelectorAll('.row-select').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.id);
        else state.selected.delete(cb.dataset.id);
      });
    });
    const selAll = $('select-all');
    if (selAll) selAll.addEventListener('change', () => {
      wrap.querySelectorAll('.row-select').forEach((cb) => {
        cb.checked = selAll.checked;
        if (selAll.checked) state.selected.add(cb.dataset.id);
        else state.selected.delete(cb.dataset.id);
      });
    });

    // Populate dynamic filter dropdowns from current page
    populateFilterOptions(state.products);
  }

  function populateFilterOptions(products) {
    const vendors = new Set(), types = new Set(), tags = new Set();
    products.forEach((p) => {
      if (p.vendor) vendors.add(p.vendor);
      if (p.productType) types.add(p.productType);
      (p.tags || []).forEach((t) => tags.add(t));
    });
    fillSelect('f-vendor',  ['', ...[...vendors].sort()], state.filters.vendor);
    fillSelect('f-type',    ['', ...[...types].sort()],   state.filters.productType);
    fillSelect('f-tag',     ['', ...[...tags].sort()],    state.filters.tag);
  }
  function fillSelect(id, values, current) {
    const sel = $(id);
    if (!sel) return;
    const had = sel.value;
    sel.innerHTML = values.map(v => `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${v ? escapeHtml(v) : 'Any'}</option>`).join('');
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    else if (had && [...sel.options].some(o => o.value === had)) sel.value = had;
  }

  async function load() {
    const status = $('list-status');
    window.App.clearStatus(status);
    try {
      const d = await fetchJson('/api/admin/products?' + buildQuery());
      state.products = d.products || [];
      state.pageInfo = d.pageInfo;
      renderProducts();
      updatePagination();
    } catch (err) {
      window.App.setStatus(status, 'err', err.message);
      $('products-table-wrap').innerHTML = '';
    }
  }

  function updatePagination() {
    const info = state.pageInfo || {};
    $('page-prev').disabled = state.cursors.length === 0;
    $('page-next').disabled = !info.hasNextPage;
    $('page-meta').textContent = `Page ${state.cursors.length + 1}${state.products.length ? ` · ${state.products.length} items` : ''}`;
  }

  // ---- Events ----
  const onSearch = debounce(() => {
    state.filters.query = $('f-query').value.trim();
    state.cursors = []; state.afterCursor = null;
    load();
  }, 300);
  $('f-query').addEventListener('input', onSearch);
  ['f-status', 'f-vendor', 'f-type', 'f-tag', 'f-sort', 'f-pagesize'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      state.filters.status = $('f-status').value;
      state.filters.vendor = $('f-vendor').value;
      state.filters.productType = $('f-type').value;
      state.filters.tag = $('f-tag').value;
      const sortVal = $('f-sort').value;
      const [k, dir] = sortVal.split(':');
      state.sortKey = k; state.reverse = dir === 'desc';
      state.pageSize = parseInt($('f-pagesize').value, 10) || 25;
      state.cursors = []; state.afterCursor = null;
      load();
    });
  });

  $('page-next').addEventListener('click', () => {
    if (!state.pageInfo || !state.pageInfo.hasNextPage) return;
    state.cursors.push(state.afterCursor);
    state.afterCursor = state.pageInfo.endCursor;
    load();
  });
  $('page-prev').addEventListener('click', () => {
    if (!state.cursors.length) return;
    state.afterCursor = state.cursors.pop() || null;
    load();
  });

  $('btn-new-product').addEventListener('click', async () => {
    const title = prompt('New product title:');
    if (!title) return;
    try {
      const d = await fetchJson('/api/admin/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, status: 'DRAFT' }),
      });
      toast('Created product');
      const numId = numericIdFromGid(d.product.id);
      window.location.href = `product.html?id=${encodeURIComponent(numId)}`;
    } catch (err) { toast(err.message, 'err'); }
  });

  $('btn-bulk-apply').addEventListener('click', async () => {
    const action = $('bulk-action').value;
    if (!action || !state.selected.size) { toast('Pick action and rows', 'err'); return; }
    if (!confirm(`Apply "${action}" to ${state.selected.size} product(s)?`)) return;
    const ids = [...state.selected];
    try {
      for (const id of ids) {
        const numId = numericIdFromGid(id);
        if (action === 'delete') {
          await fetchJson(`/api/admin/product/${numId}`, { method: 'DELETE' });
        } else if (action.startsWith('status:')) {
          const status = action.slice('status:'.length).toUpperCase();
          await fetchJson(`/api/admin/product/${numId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          });
        }
      }
      toast(`Applied to ${ids.length} product(s)`);
      state.selected.clear();
      load();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---- Analytics (carried over from old single-file dashboard) ----
  function fmt(n) { return n == null ? '—' : (typeof n === 'number' ? n.toLocaleString() : n); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString(); }
  let lastAnalytics = null;
  let lastAnalyticsAt = 0;

  function renderSpark(history) {
    const svg = $('spark');
    if (!svg) return;
    svg.innerHTML = '';
    const points = history.filter((h) => h.currentlyAvailable != null && h.maximumAvailable);
    if (points.length < 2) {
      svg.innerHTML = '<text x="300" y="70" text-anchor="middle" fill="#94a3b8" font-size="12">Make a few calls to populate the chart</text>';
      return;
    }
    const W = 600, H = 140, P = 8;
    const max = points[0].maximumAvailable;
    const xStep = (W - P * 2) / (points.length - 1);
    const yFor = (v) => H - P - ((v / max) * (H - P * 2));
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${P + i * xStep} ${yFor(p.currentlyAvailable)}`).join(' ');
    const area = path + ` L ${P + (points.length - 1) * xStep} ${H - P} L ${P} ${H - P} Z`;
    svg.innerHTML = `
      <line x1="${P}" y1="${yFor(100)}" x2="${W - P}" y2="${yFor(100)}" stroke="#f59e0b" stroke-dasharray="4 4" stroke-width="1" opacity="0.6"/>
      <path d="${area}" fill="#22c55e" opacity="0.15"/>
      <path d="${path}" fill="none" stroke="#22c55e" stroke-width="2"/>
      <text x="${W - P - 4}" y="${yFor(100) - 4}" text-anchor="end" fill="#f59e0b" font-size="10">throttle threshold (100)</text>
    `;
  }
  function renderOps(operations) {
    const wrap = $('ops-table');
    if (!wrap) return;
    if (!operations.length) { wrap.innerHTML = '<div class="empty">No calls yet.</div>'; return; }
    const rows = operations.map((o) => `
      <tr>
        <td>${escapeHtml(o.opKind)}</td>
        <td>${escapeHtml(o.opName)}</td>
        <td class="num">${o.calls}</td>
        <td class="num">${o.actualCost}</td>
        <td class="num">${o.avgDurationMs} ms</td>
      </tr>`).join('');
    wrap.innerHTML = `<table><thead><tr><th>Kind</th><th>Operation</th><th>Calls</th><th>Total Cost</th><th>Avg Latency</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function renderHistory(history) {
    const wrap = $('history-table');
    if (!wrap) return;
    const recent = history.slice().reverse().slice(0, 30);
    if (!recent.length) { wrap.innerHTML = '<div class="empty">No calls yet.</div>'; return; }
    const rows = recent.map((h) => `
      <tr>
        <td>${fmtTime(h.ts)}</td>
        <td>${escapeHtml(h.opKind)} ${escapeHtml(h.opName)}</td>
        <td class="num">${fmt(h.actualQueryCost)}</td>
        <td class="num">${fmt(h.currentlyAvailable)}/${fmt(h.maximumAvailable)}</td>
        <td class="num">${h.durationMs} ms</td>
      </tr>`).join('');
    wrap.innerHTML = `<table><thead><tr><th>Time</th><th>Operation</th><th>Cost</th><th>Bucket After</th><th>Latency</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function projectKpis() {
    if (!lastAnalytics) return;
    const d = lastAnalytics;
    const ts = d.throttle && d.throttle.throttleStatus;
    if (ts) {
      const elapsed = (Date.now() - lastAnalyticsAt) / 1000;
      const projected = Math.min(ts.maximumAvailable, ts.currentlyAvailable + ts.restoreRate * elapsed);
      $('kpi-available').textContent = Math.round(projected);
      $('kpi-max').textContent = ts.maximumAvailable;
      $('kpi-restore').textContent = ts.restoreRate + '/s';
      $('kpi-pct').textContent = ((projected / ts.maximumAvailable) * 100).toFixed(1) + '%';
    }
    $('kpi-calls').textContent = fmt(d.summary.totalCalls);
    $('kpi-cost').textContent = fmt(d.summary.totalActualCost);
    $('kpi-requested').textContent = fmt(d.summary.totalRequestedCost);
    $('kpi-latency').textContent = d.summary.avgDurationMs + ' ms';
  }
  async function refreshAnalytics() {
    try {
      const d = await fetchJson('/api/analytics');
      const incomingTs = d.throttle && d.throttle.updatedAt;
      const existingTs = lastAnalytics && lastAnalytics.throttle && lastAnalytics.throttle.updatedAt;
      const isNewer = incomingTs && incomingTs !== existingTs;
      if (isNewer || !lastAnalytics) { lastAnalytics = d; lastAnalyticsAt = Date.now(); }
      else lastAnalytics = { ...d, throttle: lastAnalytics.throttle };
      projectKpis();
      $('ana-meta').textContent = `Last Shopify call ${incomingTs ? new Date(incomingTs).toLocaleTimeString() : 'never'} · projected live · history capped at 200`;
      renderSpark(d.history);
      renderOps(d.operations);
      renderHistory(d.history);
      renderThrottle(lastAnalytics.throttle);
    } catch (err) {
      $('ana-meta').textContent = 'Error: ' + err.message;
    }
  }
  const anaBtn = $('ana-refresh');
  if (anaBtn) anaBtn.addEventListener('click', refreshAnalytics);
  setInterval(() => { if ($('view-analytics') && $('view-analytics').classList.contains('active')) projectKpis(); }, 1000);
  setInterval(() => { if ($('view-analytics') && $('view-analytics').classList.contains('active')) refreshAnalytics(); }, 5000);

  // ---- Boot ----
  load();
})();
