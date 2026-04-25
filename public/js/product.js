/* eslint-disable no-undef */
(function () {
  const { $, escapeHtml, fetchJson, qs, debounce, numericIdFromGid, gidFor, formatMoney, toast } = window.App;

  const productNumId = qs('id');
  if (!productNumId) {
    document.body.innerHTML = '<main><div class="panel">No product id in URL. <a href="index.html">Back to products</a></div></main>';
    return;
  }
  const productGid = gidFor('Product', productNumId);

  // State holders
  let product = null;
  let originalSnapshot = null;
  let dirtyFields = new Set();
  let pendingMediaDelete = new Set();   // Set<mediaId>
  let pendingMediaAlt = new Map();      // mediaId -> altText
  let pendingMediaOrder = null;         // Array<mediaId> if user dragged
  let variantsDirty = new Map();        // variantId -> patch
  let collectionsState = { current: new Set(), wanted: new Set() };
  let publicationsState = { all: [], current: new Set(), wanted: new Set() };
  let inventoryAdjustments = new Map(); // `${itemId}|${locId}` -> delta
  let metafieldsRows = [];              // [{id?, namespace, key, type, value, _new?, _delete?}]

  // ---- Boot ----
  init().catch(err => toast(err.message, 'err'));

  async function init() {
    await Promise.all([loadProduct(), loadCollectionsList(), loadPublications()]);
    bindEvents();
  }

  function setDirty(field) {
    dirtyFields.add(field);
    document.querySelector('.save-bar').classList.add('dirty');
  }
  function clearDirty() {
    dirtyFields.clear();
    pendingMediaDelete.clear();
    pendingMediaAlt.clear();
    pendingMediaOrder = null;
    variantsDirty.clear();
    inventoryAdjustments.clear();
    document.querySelector('.save-bar').classList.remove('dirty');
  }

  // ---- Load ----
  async function loadProduct() {
    const d = await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}`);
    product = d;
    originalSnapshot = JSON.stringify(d);
    render();
    await loadInventory();
  }

  async function loadCollectionsList() {
    try {
      const d = await fetchJson('/api/admin/collections?first=100');
      window.__collectionsAll = d.collections || [];
    } catch (err) {
      window.__collectionsAll = [];
    }
  }

  async function loadPublications() {
    try {
      const d = await fetchJson('/api/admin/publications');
      publicationsState.all = d.publications || [];
    } catch (err) {
      publicationsState.all = [];
    }
  }

  async function loadInventory() {
    try {
      const d = await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/inventory`);
      window.__inv = d.variants || [];
      renderInventory();
    } catch (err) {
      $('inv-table').innerHTML = `<div class="empty">Inventory unavailable: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- Render ----
  function render() {
    document.title = `${product.title || 'Product'} — Shopify Bridge`;
    $('breadcrumb-title').textContent = product.title || '(untitled)';

    $('p-title').value = product.title || '';
    $('p-status').value = product.status || 'DRAFT';
    $('p-description').value = product.descriptionHtml || '';
    $('p-handle').value = product.handle || '';
    $('p-type').value = product.productType || '';
    $('p-vendor').value = product.vendor || '';
    $('p-template').value = product.templateSuffix || '';
    $('p-seo-title').value = (product.seo && product.seo.title) || '';
    $('p-seo-desc').value = (product.seo && product.seo.description) || '';
    $('ts-created').textContent = product.createdAt || '—';
    $('ts-updated').textContent = product.updatedAt || '—';
    $('ts-published').textContent = product.publishedAt || '—';

    renderTags();
    renderMedia();
    renderVariants();
    renderCollectionsChips();
    renderPublications();
    renderMetafields();
    renderSeoPreview();
  }

  // ---- Tags ----
  function renderTags() {
    const wrap = $('tags-chip');
    const tags = product.tags || [];
    wrap.querySelectorAll('.chip').forEach(n => n.remove());
    const inputEl = wrap.querySelector('input');
    tags.slice().reverse().forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${escapeHtml(t)}<button type="button" aria-label="remove">×</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        product.tags = (product.tags || []).filter(x => x !== t);
        setDirty('tags');
        renderTags();
      });
      wrap.insertBefore(chip, inputEl);
    });
  }
  function addTagFromInput(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = e.target.value.trim().replace(/,$/, '');
      if (!v) return;
      product.tags = product.tags || [];
      if (!product.tags.includes(v)) {
        product.tags.push(v);
        setDirty('tags');
        renderTags();
      }
      e.target.value = '';
    }
  }

  // ---- Media ----
  function renderMedia() {
    const grid = $('media-grid');
    const items = (product.images || []).map((img) => {
      const id = img.id;
      const alt = pendingMediaAlt.has(id) ? pendingMediaAlt.get(id) : (img.altText || '');
      const deleted = pendingMediaDelete.has(id);
      return `
        <div class="media-item ${deleted ? 'deleted' : ''}" draggable="true" data-id="${escapeHtml(id)}">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <img src="${escapeHtml(img.url)}" alt="">
          <input type="text" class="alt-input" placeholder="Alt text" value="${escapeHtml(alt)}" data-id="${escapeHtml(id)}">
          <div class="row">
            <button type="button" class="muted small btn-undelete" data-id="${escapeHtml(id)}" ${deleted ? '' : 'style="display:none"'}>Restore</button>
            <button type="button" class="danger small btn-delete" data-id="${escapeHtml(id)}" ${deleted ? 'style="display:none"' : ''}>Delete</button>
          </div>
        </div>
      `;
    }).join('');
    grid.innerHTML = items || '<div class="empty">No images yet. Add one below.</div>';

    grid.querySelectorAll('.alt-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        pendingMediaAlt.set(inp.dataset.id, inp.value);
        setDirty('media-alt');
      });
    });
    grid.querySelectorAll('.btn-delete').forEach((b) => {
      b.addEventListener('click', () => { pendingMediaDelete.add(b.dataset.id); setDirty('media-del'); renderMedia(); });
    });
    grid.querySelectorAll('.btn-undelete').forEach((b) => {
      b.addEventListener('click', () => { pendingMediaDelete.delete(b.dataset.id); renderMedia(); });
    });
    enableMediaDnD(grid);
  }

  function enableMediaDnD(grid) {
    let dragging = null;
    grid.querySelectorAll('.media-item').forEach((el) => {
      el.addEventListener('dragstart', () => { dragging = el; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { if (dragging) dragging.classList.remove('dragging'); dragging = null; grid.querySelectorAll('.media-item').forEach(n => n.classList.remove('drag-over')); });
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragging || dragging === el) return;
        const allEls = [...grid.querySelectorAll('.media-item')];
        const fromIdx = allEls.indexOf(dragging);
        const toIdx = allEls.indexOf(el);
        if (fromIdx < 0 || toIdx < 0) return;
        // reorder local product.images
        const arr = product.images.slice();
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, moved);
        product.images = arr;
        pendingMediaOrder = arr.map(i => i.id);
        setDirty('media-order');
        renderMedia();
      });
    });
  }

  // ---- Variants ----
  function renderVariants() {
    const wrap = $('variants-table-wrap');
    const variants = product.variants || [];
    if (!variants.length) {
      wrap.innerHTML = '<div class="empty">No variants. Add one above.</div>';
      return;
    }
    const rows = variants.map((v) => {
      const optTxt = (v.selectedOptions || []).map(o => `${o.name}: ${o.value}`).join(' / ');
      return `
        <tr data-id="${escapeHtml(v.id)}">
          <td class="col-img">${v.image && v.image.url ? `<img src="${escapeHtml(v.image.url)}" alt="">` : ''}</td>
          <td>${escapeHtml(optTxt || v.title || '')}</td>
          <td><input class="v-field" data-field="sku" value="${escapeHtml(v.sku || '')}"></td>
          <td><input class="v-field" data-field="barcode" value="${escapeHtml(v.barcode || '')}"></td>
          <td><input class="v-field" data-field="price" value="${escapeHtml(v.price || '')}"></td>
          <td><input class="v-field" data-field="compareAtPrice" value="${escapeHtml(v.compareAtPrice || '')}"></td>
          <td class="num">${v.inventoryQuantity == null ? '—' : v.inventoryQuantity}</td>
          <td>
            <select class="v-field" data-field="inventoryPolicy">
              <option value="DENY" ${v.inventoryPolicy === 'DENY' ? 'selected' : ''}>Deny</option>
              <option value="CONTINUE" ${v.inventoryPolicy === 'CONTINUE' ? 'selected' : ''}>Continue</option>
            </select>
          </td>
          <td><input type="checkbox" class="v-field" data-field="taxable" ${v.taxable ? 'checked' : ''}></td>
          <td><button type="button" class="danger small btn-del-var" data-id="${escapeHtml(v.id)}">Delete</button></td>
        </tr>
      `;
    }).join('');
    wrap.innerHTML = `
      <table class="variants-table">
        <thead><tr><th></th><th>Options</th><th>SKU</th><th>Barcode</th><th>Price</th><th>Compare</th><th>Qty</th><th>Policy</th><th>Tax</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    wrap.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll('.v-field').forEach((inp) => {
        inp.addEventListener('input', () => {
          const patch = variantsDirty.get(id) || { id };
          if (inp.type === 'checkbox') patch[inp.dataset.field] = inp.checked;
          else patch[inp.dataset.field] = inp.value;
          variantsDirty.set(id, patch);
          setDirty('variants');
        });
        inp.addEventListener('change', () => {
          const patch = variantsDirty.get(id) || { id };
          if (inp.type === 'checkbox') patch[inp.dataset.field] = inp.checked;
          else patch[inp.dataset.field] = inp.value;
          variantsDirty.set(id, patch);
          setDirty('variants');
        });
      });
    });
    wrap.querySelectorAll('.btn-del-var').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this variant?')) return;
        try {
          await fetchJson(`/api/admin/variant/${encodeURIComponent(numericIdFromGid(b.dataset.id))}`, { method: 'DELETE' });
          toast('Variant deleted');
          await loadProduct();
        } catch (err) { toast(err.message, 'err'); }
      });
    });
  }

  // ---- Collections ----
  function renderCollectionsChips() {
    const wrap = $('collections-wrap');
    const all = window.__collectionsAll || [];
    const current = new Set((product.collections || []).map(c => c.id));
    collectionsState.current = current;
    if (!collectionsState.wanted.size) collectionsState.wanted = new Set(current);
    const opts = all.map(c => {
      const checked = collectionsState.wanted.has(c.id);
      return `<label class="checkbox"><input type="checkbox" data-id="${escapeHtml(c.id)}" ${checked ? 'checked' : ''}> ${escapeHtml(c.title)}</label>`;
    }).join('');
    wrap.innerHTML = opts || '<div class="empty">No collections.</div>';
    wrap.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) collectionsState.wanted.add(cb.dataset.id);
        else collectionsState.wanted.delete(cb.dataset.id);
        setDirty('collections');
      });
    });
  }

  // ---- Publications ----
  function renderPublications() {
    const wrap = $('publications-wrap');
    // Mark "current" pubs as wanted by default; we don't have access to which channels the product is on without an extra query.
    const opts = publicationsState.all.map((p) => {
      const checked = publicationsState.wanted.has(p.id);
      return `<label class="checkbox"><input type="checkbox" data-id="${escapeHtml(p.id)}" ${checked ? 'checked' : ''}> ${escapeHtml(p.name)}</label>`;
    }).join('');
    wrap.innerHTML = opts || '<div class="empty">No publications.</div>';
    wrap.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) publicationsState.wanted.add(cb.dataset.id);
        else publicationsState.wanted.delete(cb.dataset.id);
        setDirty('publications');
      });
    });
  }

  // ---- Metafields ----
  function renderMetafields() {
    metafieldsRows = (product.metafields || []).map(m => ({ ...m }));
    drawMetafields();
  }
  function drawMetafields() {
    const wrap = $('metafields-wrap');
    const rows = metafieldsRows.map((m, idx) => {
      if (m._delete) return '';
      return `
        <div class="meta-row" data-idx="${idx}">
          <input class="mf-field" data-field="namespace" placeholder="namespace" value="${escapeHtml(m.namespace || '')}">
          <input class="mf-field" data-field="key" placeholder="key" value="${escapeHtml(m.key || '')}">
          <select class="mf-field" data-field="type">
            ${['single_line_text_field','multi_line_text_field','number_integer','number_decimal','json','boolean','url'].map(t =>
              `<option value="${t}" ${m.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <textarea class="mf-field" data-field="value" placeholder="value">${escapeHtml(m.value || '')}</textarea>
          <button type="button" class="danger small del">Delete</button>
        </div>
      `;
    }).join('');
    wrap.innerHTML = rows || '<div class="empty">No metafields.</div>';
    wrap.querySelectorAll('.meta-row').forEach((row) => {
      const idx = parseInt(row.dataset.idx, 10);
      row.querySelectorAll('.mf-field').forEach((inp) => {
        inp.addEventListener('input', () => { metafieldsRows[idx][inp.dataset.field] = inp.value; setDirty('metafields'); });
      });
      row.querySelector('.del').addEventListener('click', async () => {
        const m = metafieldsRows[idx];
        if (m.id) {
          if (!confirm('Delete this metafield from Shopify now?')) return;
          try {
            await fetchJson(`/api/admin/metafield/${encodeURIComponent(numericIdFromGid(m.id))}`, { method: 'DELETE' });
            metafieldsRows[idx]._delete = true;
            drawMetafields();
            toast('Metafield deleted');
          } catch (err) { toast(err.message, 'err'); }
        } else {
          metafieldsRows.splice(idx, 1);
          drawMetafields();
        }
      });
    });
  }

  // ---- SEO preview ----
  function renderSeoPreview() {
    const t = $('p-seo-title').value || $('p-title').value || '(no title)';
    const d = $('p-seo-desc').value || (product.descriptionHtml ? product.descriptionHtml.replace(/<[^>]+>/g, '').slice(0, 160) : '');
    const handle = $('p-handle').value || product.handle || 'product';
    $('seo-preview').innerHTML = `
      <div class="url">https://your-shop.com/products/${escapeHtml(handle)}</div>
      <div class="title">${escapeHtml(t)}</div>
      <div class="desc">${escapeHtml(d)}</div>
    `;
  }

  // ---- Inventory ----
  function renderInventory() {
    const wrap = $('inv-table');
    const inv = window.__inv || [];
    if (!inv.length) { wrap.innerHTML = '<div class="empty">No inventory rows.</div>'; return; }
    let html = '';
    inv.forEach((v) => {
      const rows = (v.levels || []).map((lvl) => {
        const key = `${v.inventoryItemId}|${lvl.locationId}`;
        const delta = inventoryAdjustments.get(key) || 0;
        return `
          <tr>
            <td>${escapeHtml(lvl.locationName || lvl.locationId)}</td>
            <td class="num">${lvl.available}</td>
            <td><input type="number" class="adj-input" data-key="${escapeHtml(key)}" value="${delta}"></td>
            <td class="num">${lvl.available + delta}</td>
          </tr>
        `;
      }).join('');
      html += `
        <h3>${escapeHtml(v.title || v.sku || numericIdFromGid(v.variantId))}</h3>
        <table>
          <thead><tr><th>Location</th><th>Available</th><th>Δ</th><th>New</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="empty">No locations</td></tr>'}</tbody>
        </table>
      `;
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('.adj-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const v = parseInt(inp.value, 10) || 0;
        if (v === 0) inventoryAdjustments.delete(inp.dataset.key);
        else inventoryAdjustments.set(inp.dataset.key, v);
        setDirty('inventory');
        // update "new" cell
        const tr = inp.closest('tr');
        const avail = parseInt(tr.children[1].textContent, 10) || 0;
        tr.children[3].textContent = String(avail + v);
      });
    });
  }

  // ---- Events ----
  function bindEvents() {
    [
      ['p-title','title'], ['p-handle','handle'], ['p-status','status'],
      ['p-description','descriptionHtml'], ['p-type','productType'], ['p-vendor','vendor'],
      ['p-template','templateSuffix'], ['p-seo-title','seo.title'], ['p-seo-desc','seo.description'],
    ].forEach(([id, field]) => {
      const el = $(id);
      el.addEventListener('input', () => { setDirty(field); renderSeoPreview(); });
    });

    $('tag-input').addEventListener('keydown', addTagFromInput);

    $('btn-add-image').addEventListener('click', async () => {
      const src = $('new-image-url').value.trim();
      const altText = $('new-image-alt').value.trim();
      if (!src) { toast('Enter a URL', 'err'); return; }
      try {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/media`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images: [{ src, altText }] }),
        });
        $('new-image-url').value = ''; $('new-image-alt').value = '';
        toast('Image added');
        await loadProduct();
      } catch (err) { toast(err.message, 'err'); }
    });

    $('btn-add-variant').addEventListener('click', async () => {
      const price = prompt('Price for new variant (e.g. 19.99):', '0.00');
      if (price == null) return;
      try {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/variants`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ price: String(price), options: ['New'] }),
        });
        toast('Variant added');
        await loadProduct();
      } catch (err) { toast(err.message, 'err'); }
    });

    $('btn-add-metafield').addEventListener('click', () => {
      metafieldsRows.push({ namespace: 'custom', key: '', type: 'single_line_text_field', value: '', _new: true });
      setDirty('metafields');
      drawMetafields();
    });

    $('btn-save').addEventListener('click', save);
    $('btn-discard').addEventListener('click', () => { if (confirm('Discard unsaved changes?')) location.reload(); });
    $('btn-duplicate').addEventListener('click', async () => {
      const newTitle = prompt('Title for the copy:', `Copy of ${product.title || ''}`);
      if (!newTitle) return;
      try {
        const d = await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/duplicate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newTitle }),
        });
        toast('Duplicated');
        const numId = numericIdFromGid(d.product.id);
        window.location.href = `product.html?id=${encodeURIComponent(numId)}`;
      } catch (err) { toast(err.message, 'err'); }
    });
    $('btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${product.title}"? This cannot be undone.`)) return;
      try {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}`, { method: 'DELETE' });
        toast('Deleted'); window.location.href = 'index.html';
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ---- Save ----
  async function save() {
    const btn = $('btn-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      // 1) Collect product PUT body from dirty fields
      const body = {};
      const map = {
        'title': () => body.title = $('p-title').value,
        'handle': () => body.handle = $('p-handle').value,
        'status': () => body.status = $('p-status').value,
        'descriptionHtml': () => body.descriptionHtml = $('p-description').value,
        'productType': () => body.productType = $('p-type').value,
        'vendor': () => body.vendor = $('p-vendor').value,
        'templateSuffix': () => body.templateSuffix = $('p-template').value,
        'tags': () => body.tags = product.tags || [],
        'seo.title': () => { body.seo = body.seo || {}; body.seo.title = $('p-seo-title').value; },
        'seo.description': () => { body.seo = body.seo || {}; body.seo.description = $('p-seo-desc').value; },
      };
      for (const f of dirtyFields) if (map[f]) map[f]();

      // 2) Variants
      if (variantsDirty.size) body.variants = [...variantsDirty.values()];

      // 3) Media: alt updates + deletes (reorder handled by separate endpoint)
      const altUpdates = [...pendingMediaAlt.entries()]
        .filter(([id, alt]) => !pendingMediaDelete.has(id))
        .map(([id, altText]) => ({ id, altText }));
      // imagesToUpdate uses image gid, not media gid — keep as-is for our updateProduct path
      if (altUpdates.length) body.imagesToUpdate = altUpdates;
      if (pendingMediaDelete.size) body.imagesToDelete = [...pendingMediaDelete];

      // 4) Metafields (upsert dirty rows that aren't deleted)
      const upsertMfs = metafieldsRows.filter(m => !m._delete && (m._new || dirtyFields.has('metafields')));
      // Use the dedicated metafields endpoint to be explicit
      const mfsToSet = upsertMfs.filter(m => m.namespace && m.key && m.value !== '').map(m => ({
        namespace: m.namespace, key: m.key, value: String(m.value), type: m.type || 'single_line_text_field',
      }));

      // ---- Call the main PUT (only if something present)
      const hasMain = Object.keys(body).length > 0;
      if (hasMain) {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      // Reorder
      if (pendingMediaOrder && pendingMediaOrder.length) {
        const moves = pendingMediaOrder.map((id, i) => ({ id, newPosition: String(i) }));
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/media/reorder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ moves }),
        });
      }

      // Metafields
      if (mfsToSet.length) {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/metafields`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metafields: mfsToSet }),
        });
      }

      // Collections diff
      if (dirtyFields.has('collections')) {
        const toAdd = [...collectionsState.wanted].filter(id => !collectionsState.current.has(id));
        const toRem = [...collectionsState.current].filter(id => !collectionsState.wanted.has(id));
        if (toAdd.length) {
          await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/collections/add`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionIds: toAdd }),
          });
        }
        if (toRem.length) {
          await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/collections/remove`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionIds: toRem }),
          });
        }
      }

      // Publications
      if (dirtyFields.has('publications') && publicationsState.wanted.size) {
        await fetchJson(`/api/admin/product/${encodeURIComponent(productNumId)}/publish`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicationIds: [...publicationsState.wanted] }),
        });
      }

      // Inventory adjust
      if (inventoryAdjustments.size) {
        const changes = [...inventoryAdjustments.entries()].map(([k, delta]) => {
          const [inventoryItemId, locationId] = k.split('|');
          return { inventoryItemId, locationId, delta };
        });
        await fetchJson('/api/admin/inventory/adjust', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'correction', changes }),
        });
      }

      toast('Saved');
      clearDirty();
      await loadProduct();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }
})();
