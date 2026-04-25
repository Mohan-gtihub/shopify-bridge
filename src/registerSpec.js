/**
 * Registers every endpoint in the app into the spec registry.
 * Pure metadata — no side effects on the routes themselves.
 */
const { register } = require('./apiSpec');

// ===== auth =====
register({
  method: 'GET', path: '/auth', tags: ['auth'],
  summary: 'Begin Shopify OAuth install flow',
  description: 'Redirects the browser to Shopify for the install/approval screen.',
  responseExample: '302 redirect to https://{shop}/admin/oauth/authorize?...',
});
register({
  method: 'GET', path: '/callback', tags: ['auth'],
  summary: 'OAuth callback — exchanges code for an access token',
  query: { code: { type: 'string', required: true, description: 'Authorization code from Shopify' } },
  responseExample: 'HTML page confirming setup',
});

// ===== throttle / analytics / list =====
register({
  method: 'GET', path: '/api/products', tags: ['products'],
  summary: 'List products via the smart shopifyQuery client',
  query: {
    limit:   { type: 'integer', required: false, description: '1..250, default 10' },
    sortKey: { type: 'string',  required: false, description: 'TITLE | CREATED_AT | UPDATED_AT | PRODUCT_TYPE | VENDOR | INVENTORY_TOTAL | PUBLISHED_AT | ID | RELEVANCE' },
    reverse: { type: 'boolean', required: false, description: 'Reverse sort' },
  },
  responseExample: { products: [{ id: 'gid://shopify/Product/1', title: 'Tee', price: '19.99' }], throttle: { throttleStatus: { currentlyAvailable: 1900, maximumAvailable: 2000, restoreRate: 100 } } },
});
register({
  method: 'POST', path: '/api/product/update', tags: ['products'],
  summary: 'Update product title/description/seo and/or first variant price',
  body: {
    id:          { type: 'string', required: true,  description: 'Product gid or numeric id' },
    title:       { type: 'string', required: false },
    description: { type: 'string', required: false, description: 'HTML' },
    price:       { type: 'string', required: false, description: 'Updates the FIRST variant price' },
    seo:         { type: 'object', required: false, description: '{ title, description }' },
  },
  responseExample: { success: true, product: { id: 'gid://shopify/Product/1', title: 'Tee' }, variant: { id: 'gid://shopify/ProductVariant/1', price: '19.99' } },
});
register({
  method: 'GET', path: '/api/throttle', tags: ['analytics'],
  summary: 'Latest Shopify throttle telemetry for the active shop',
  responseExample: { throttle: { throttleStatus: { currentlyAvailable: 1900, maximumAvailable: 2000, restoreRate: 100 }, updatedAt: '2026-04-25T00:00:00Z' } },
});
register({
  method: 'GET', path: '/api/analytics', tags: ['analytics'],
  summary: 'Aggregate call history, per-op cost, latency, and bucket trend',
  responseExample: { summary: { totalCalls: 12, totalActualCost: 144, avgDurationMs: 230 }, history: [], operations: [], throttle: {} },
});

// ===== unified shopify endpoints =====
register({
  method: 'GET', path: '/api/shopify', tags: ['shopify'],
  summary: 'Fetch all products + collections (paginated server-side)',
  responseExample: { products: [], collections: [], meta: { fetched_at: '2026-04-25T00:00:00Z' } },
});
register({
  method: 'GET', path: '/api/shopify/product/:id', tags: ['shopify'],
  params: { id: { type: 'string', required: true, description: 'gid or numeric id' } },
  summary: 'Fetch one full product (PRODUCT_FIELDS shape)',
  responseExample: { id: 'gid://shopify/Product/1', title: 'Tee', variants: [], images: [] },
});
register({
  method: 'GET', path: '/api/shopify/collection/:id', tags: ['shopify'],
  params: { id: { type: 'string', required: true, description: 'gid or numeric id' } },
  summary: 'Fetch one full collection',
  responseExample: { id: 'gid://shopify/Collection/1', title: 'Sale' },
});
register({
  method: 'POST', path: '/api/shopify/update', tags: ['shopify'],
  summary: 'Unified write — update a product or collection',
  body: {
    type: { type: 'string', required: true, description: 'product | collection' },
    id:   { type: 'string', required: true, description: 'gid or numeric id' },
    data: { type: 'object', required: true, description: 'Fields to update; supports imagesToCreate/imagesToUpdate/imagesToDelete/variants for products' },
  },
  responseExample: { success: true, result: { id: 'gid://shopify/Product/1' } },
});
register({
  method: 'POST', path: '/api/shopify/bulk-update', tags: ['shopify'],
  summary: 'Apply an array of updates concurrently',
  body: { updates: { type: 'array', required: true, description: 'Each item: { type, id, data }' } },
  responseExample: { total: 2, succeeded: 2, failed: 0, results: [] },
});

// ===== docs =====
register({
  method: 'GET', path: '/api/_docs', tags: ['docs'],
  summary: 'This document — machine-readable spec of all endpoints',
  responseExample: { endpoints: [], generatedAt: '2026-04-25T00:00:00Z', shop: 'foo.myshopify.com', apiVersion: '2024-07' },
});

// ===== admin: products =====
const PROD_LIST_EX = {
  products: [{
    cursor: 'eyJsYXN0X2lkIjoxfQ==',
    id: 'gid://shopify/Product/1', title: 'Tee', handle: 'tee', status: 'ACTIVE',
    vendor: 'Acme', productType: 'Apparel', tags: ['sale'], totalInventory: 42,
    featuredImage: { url: 'https://cdn.shopify.com/.../tee.jpg' },
    priceRangeV2: { minVariantPrice: { amount: '19.99', currencyCode: 'USD' }, maxVariantPrice: { amount: '29.99', currencyCode: 'USD' } },
    updatedAt: '2026-04-25T00:00:00Z',
  }],
  pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'a', endCursor: 'b' },
};

register({
  method: 'GET', path: '/api/admin/products', tags: ['admin', 'products'],
  summary: 'Cursor-paginated, filterable, sortable product list',
  query: {
    query:        { type: 'string',  required: false, description: 'Free-text search (Shopify query syntax allowed)' },
    status:       { type: 'string',  required: false, description: 'ACTIVE | DRAFT | ARCHIVED' },
    vendor:       { type: 'string',  required: false },
    productType:  { type: 'string',  required: false },
    tag:          { type: 'string',  required: false },
    collectionId: { type: 'string',  required: false, description: 'Numeric or gid' },
    sortKey:      { type: 'string',  required: false, description: 'ProductSortKeys; default UPDATED_AT' },
    reverse:      { type: 'boolean', required: false },
    first:        { type: 'integer', required: false, description: '1..250, default 25' },
    after:        { type: 'string',  required: false },
    before:       { type: 'string',  required: false },
  },
  responseExample: PROD_LIST_EX,
});
register({
  method: 'GET', path: '/api/admin/product/:id', tags: ['admin', 'products'],
  summary: 'Full product record (all editable fields)',
  params: { id: { type: 'string', required: true } },
  responseExample: { id: 'gid://shopify/Product/1', title: 'Tee', variants: [], media: [], metafields: [] },
});
register({
  method: 'PUT', path: '/api/admin/product/:id', tags: ['admin', 'products'],
  summary: 'Update product + nested variants/media/metafields',
  params: { id: { type: 'string', required: true } },
  body: {
    title:           { type: 'string',  required: false },
    handle:          { type: 'string',  required: false },
    descriptionHtml: { type: 'string',  required: false },
    productType:     { type: 'string',  required: false },
    vendor:          { type: 'string',  required: false },
    status:          { type: 'string',  required: false, description: 'ACTIVE | DRAFT | ARCHIVED' },
    tags:            { type: 'array',   required: false, description: 'string[]' },
    templateSuffix:  { type: 'string',  required: false },
    giftCard:        { type: 'boolean', required: false },
    seo:             { type: 'object',  required: false, description: '{ title, description }' },
    metafields:      { type: 'array',   required: false, description: '[{ id?, namespace, key, value, type }]' },
    variants:        { type: 'array',   required: false, description: '[{ id, price, compareAtPrice, sku, barcode, inventoryPolicy, taxable, taxCode, position, title, imageId }]' },
    imagesToCreate:  { type: 'array',   required: false, description: '[{ src, altText }]' },
    imagesToUpdate:  { type: 'array',   required: false, description: '[{ id, altText, src }]' },
    imagesToDelete:  { type: 'array',   required: false, description: 'mediaId[]' },
  },
  responseExample: { success: true, product: { id: 'gid://shopify/Product/1', title: 'New Title' } },
});
register({
  method: 'POST', path: '/api/admin/product/:id/duplicate', tags: ['admin', 'products'],
  summary: 'Duplicate a product',
  params: { id: { type: 'string', required: true } },
  body: { newTitle: { type: 'string', required: false, description: 'Title for the copy' } },
  responseExample: { success: true, product: { id: 'gid://shopify/Product/2', title: 'Copy of Tee' } },
});
register({
  method: 'DELETE', path: '/api/admin/product/:id', tags: ['admin', 'products'],
  summary: 'Delete a product',
  params: { id: { type: 'string', required: true } },
  responseExample: { success: true, deletedProductId: 'gid://shopify/Product/1' },
});
register({
  method: 'POST', path: '/api/admin/product', tags: ['admin', 'products'],
  summary: 'Create a new product',
  body: {
    title:           { type: 'string',  required: true  },
    descriptionHtml: { type: 'string',  required: false },
    productType:     { type: 'string',  required: false },
    vendor:          { type: 'string',  required: false },
    status:          { type: 'string',  required: false },
    tags:            { type: 'array',   required: false },
    options:         { type: 'array',   required: false, description: '[{ name, values: [string] }]' },
    variants:        { type: 'array',   required: false },
  },
  responseExample: { success: true, product: { id: 'gid://shopify/Product/3' } },
});

// variants
register({
  method: 'GET', path: '/api/admin/product/:id/variants', tags: ['admin', 'variants'],
  summary: 'List variants for a product',
  params: { id: { type: 'string', required: true } },
  responseExample: { variants: [{ id: 'gid://shopify/ProductVariant/1', price: '19.99' }] },
});
register({
  method: 'POST', path: '/api/admin/product/:id/variants', tags: ['admin', 'variants'],
  summary: 'Create a new variant',
  params: { id: { type: 'string', required: true } },
  body: { price: { type: 'string', required: false }, sku: { type: 'string', required: false }, options: { type: 'array', required: false } },
  responseExample: { success: true, variant: { id: 'gid://shopify/ProductVariant/2', price: '24.99' } },
});
register({
  method: 'PUT', path: '/api/admin/variant/:id', tags: ['admin', 'variants'],
  summary: 'Update a single variant',
  params: { id: { type: 'string', required: true } },
  body: { price: { type: 'string', required: false }, compareAtPrice: { type: 'string', required: false }, sku: { type: 'string', required: false }, barcode: { type: 'string', required: false }, inventoryPolicy: { type: 'string', required: false }, taxable: { type: 'boolean', required: false } },
  responseExample: { success: true, variant: { id: 'gid://shopify/ProductVariant/1', price: '20.00' } },
});
register({
  method: 'DELETE', path: '/api/admin/variant/:id', tags: ['admin', 'variants'],
  summary: 'Delete a variant',
  params: { id: { type: 'string', required: true } },
  responseExample: { success: true, deletedProductVariantId: 'gid://shopify/ProductVariant/1' },
});

// media
register({
  method: 'POST', path: '/api/admin/product/:id/media', tags: ['admin', 'media'],
  summary: 'Append images by URL',
  params: { id: { type: 'string', required: true } },
  body: { images: { type: 'array', required: true, description: '[{ src, altText }]' } },
  responseExample: { success: true, media: [{ id: 'gid://shopify/MediaImage/1', alt: 'Front' }] },
});
register({
  method: 'PUT', path: '/api/admin/product/:id/media/:mediaId', tags: ['admin', 'media'],
  summary: 'Update a media item (alt text, source)',
  params: { id: { type: 'string', required: true }, mediaId: { type: 'string', required: true } },
  body: { altText: { type: 'string', required: false }, src: { type: 'string', required: false } },
  responseExample: { success: true, media: { id: 'gid://shopify/MediaImage/1', alt: 'New alt' } },
});
register({
  method: 'DELETE', path: '/api/admin/product/:id/media', tags: ['admin', 'media'],
  summary: 'Delete one or more media items',
  params: { id: { type: 'string', required: true } },
  body: { mediaIds: { type: 'array', required: true } },
  responseExample: { success: true, deletedMediaIds: ['gid://shopify/MediaImage/1'] },
});
register({
  method: 'POST', path: '/api/admin/product/:id/media/reorder', tags: ['admin', 'media'],
  summary: 'Reorder media',
  params: { id: { type: 'string', required: true } },
  body: { moves: { type: 'array', required: true, description: '[{ id, newPosition }]' } },
  responseExample: { success: true, job: { id: 'gid://shopify/Job/1' } },
});

// metafields
register({
  method: 'GET', path: '/api/admin/product/:id/metafields', tags: ['admin', 'metafields'],
  summary: 'List metafields for a product',
  params: { id: { type: 'string', required: true } },
  responseExample: { metafields: [{ id: 'gid://shopify/Metafield/1', namespace: 'custom', key: 'spec', value: 'X', type: 'single_line_text_field' }] },
});
register({
  method: 'POST', path: '/api/admin/product/:id/metafields', tags: ['admin', 'metafields'],
  summary: 'Set (upsert) metafields on a product',
  params: { id: { type: 'string', required: true } },
  body: { metafields: { type: 'array', required: true, description: '[{ namespace, key, value, type }]' } },
  responseExample: { success: true, metafields: [{ id: 'gid://shopify/Metafield/1' }] },
});
register({
  method: 'DELETE', path: '/api/admin/metafield/:id', tags: ['admin', 'metafields'],
  summary: 'Delete a metafield',
  params: { id: { type: 'string', required: true } },
  responseExample: { success: true, deletedId: 'gid://shopify/Metafield/1' },
});

// collections
register({
  method: 'GET', path: '/api/admin/collections', tags: ['admin', 'collections'],
  summary: 'Cursor-paginated collections list',
  query: { query: { type: 'string', required: false }, first: { type: 'integer', required: false }, after: { type: 'string', required: false }, sortKey: { type: 'string', required: false }, reverse: { type: 'boolean', required: false } },
  responseExample: { collections: [{ id: 'gid://shopify/Collection/1', title: 'Sale' }], pageInfo: { hasNextPage: false } },
});
register({
  method: 'POST', path: '/api/admin/product/:id/collections/add', tags: ['admin', 'collections'],
  summary: 'Add product to one or more collections',
  params: { id: { type: 'string', required: true } },
  body: { collectionIds: { type: 'array', required: true } },
  responseExample: { success: true, results: [] },
});
register({
  method: 'POST', path: '/api/admin/product/:id/collections/remove', tags: ['admin', 'collections'],
  summary: 'Remove product from one or more collections',
  params: { id: { type: 'string', required: true } },
  body: { collectionIds: { type: 'array', required: true } },
  responseExample: { success: true, results: [] },
});

// publications
register({
  method: 'GET', path: '/api/admin/publications', tags: ['admin', 'publications'],
  summary: 'List sales channels (publications)',
  responseExample: { publications: [{ id: 'gid://shopify/Publication/1', name: 'Online Store' }] },
});
register({
  method: 'POST', path: '/api/admin/product/:id/publish', tags: ['admin', 'publications'],
  summary: 'Publish product to a list of publications',
  params: { id: { type: 'string', required: true } },
  body: { publicationIds: { type: 'array', required: true } },
  responseExample: { success: true },
});
register({
  method: 'POST', path: '/api/admin/product/:id/unpublish', tags: ['admin', 'publications'],
  summary: 'Unpublish product from a list of publications',
  params: { id: { type: 'string', required: true } },
  body: { publicationIds: { type: 'array', required: true } },
  responseExample: { success: true },
});

// inventory
register({
  method: 'GET', path: '/api/admin/product/:id/inventory', tags: ['admin', 'inventory'],
  summary: 'Per-variant per-location inventory levels',
  params: { id: { type: 'string', required: true } },
  responseExample: { variants: [{ variantId: 'gid://shopify/ProductVariant/1', inventoryItemId: 'gid://shopify/InventoryItem/1', levels: [{ locationId: 'gid://shopify/Location/1', locationName: 'Main', available: 12 }] }] },
});
register({
  method: 'POST', path: '/api/admin/inventory/adjust', tags: ['admin', 'inventory'],
  summary: 'Adjust inventory (delta) at one or more locations',
  body: { reason: { type: 'string', required: false, description: 'Defaults to "correction"' }, changes: { type: 'array', required: true, description: '[{ inventoryItemId, locationId, delta }]' } },
  responseExample: { success: true, group: { id: 'gid://shopify/InventoryAdjustmentGroup/1', reason: 'correction' } },
});
register({
  method: 'GET', path: '/api/admin/locations', tags: ['admin', 'inventory'],
  summary: 'List the shop\'s locations',
  responseExample: { locations: [{ id: 'gid://shopify/Location/1', name: 'Main' }] },
});

// shop
register({
  method: 'GET', path: '/api/admin/shop', tags: ['admin', 'shop'],
  summary: 'Shop info (name, currency, primary domain, plan)',
  responseExample: { shop: { name: 'My Store', email: 'me@store.com', currencyCode: 'USD', myshopifyDomain: 'foo.myshopify.com', primaryDomain: { url: 'https://store.com' }, plan: { displayName: 'Basic' } } },
});

module.exports = {};
