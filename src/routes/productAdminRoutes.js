/**
 * Expanded admin endpoints for the Shopify-parity dashboard.
 * Mirrors the existing apiRoutes pattern: getSession() + new ShopifyService(...)
 * and uses the structured BridgeError/sendError helpers.
 */
const express = require('express');
const { getSession } = require('../utils/storage');
const ShopifyService = require('../services/shopifyService');
const { BridgeError, sendError } = require('../utils/errors');
const { flattenNode, flattenEdges } = require('../utils/transformer');

const router = express.Router();

// ---- middleware ----
router.use((req, res, next) => {
  // 1. Check for Agent/MCP API Key first
  const agentKey = req.get('X-Bridge-API-Key');
  if (agentKey && agentKey === process.env.BRIDGE_API_KEY && process.env.SHOP && process.env.SHOPIFY_ACCESS_TOKEN) {
    req.shopifyService = new ShopifyService(process.env.SHOP, process.env.SHOPIFY_ACCESS_TOKEN);
    req.shopifySession = { shop: process.env.SHOP, token: process.env.SHOPIFY_ACCESS_TOKEN, source: 'key' };
    return next();
  }

  // 2. Fallback to browser session
  const session = getSession();
  if (!session || !session.token) {
    return next(new BridgeError('No Shopify session. Authenticate at /auth or provide X-Bridge-API-Key.', { status: 401, code: 'UNAUTHORIZED' }));
  }
  req.shopifyService = new ShopifyService(session.shop, session.token);
  req.shopifySession = session;
  next();
});

// ---- helpers ----
function gid(type, id) {
  if (typeof id === 'string' && id.startsWith('gid://')) return id;
  return `gid://shopify/${type}/${id}`;
}

const PRODUCT_LIST_FIELDS = `
  id title handle status vendor productType tags totalInventory updatedAt createdAt
  featuredImage { id url altText }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  variants(first: 1) { edges { node { id price sku } } }
`;

const PRODUCT_FULL_FIELDS = `
  id title handle descriptionHtml productType vendor status tags templateSuffix
  onlineStoreUrl totalInventory tracksInventory createdAt updatedAt publishedAt
  seo { title description }
  featuredImage { id url altText width height }
  images(first: 50) { edges { node { id url altText width height } } }
  media(first: 50) { edges { node {
    ... on MediaImage { id alt mediaContentType image { url width height } }
    ... on Video { id alt mediaContentType sources { url mimeType format height width } }
    ... on ExternalVideo { id alt mediaContentType originUrl }
    ... on Model3d { id alt mediaContentType sources { url mimeType format } }
  } } }
  options { id name position values }
  variants(first: 100) { edges { node {
    id title sku barcode price compareAtPrice position
    inventoryQuantity inventoryPolicy taxable taxCode
    selectedOptions { name value }
    image { id url altText }
    inventoryItem { id }
  } } }
  metafields(first: 50) { edges { node { id namespace key value type description } } }
  collections(first: 20) { edges { node { id title handle } } }
`;

function buildProductSearchQuery({ query, status, vendor, productType, tag, collectionId }) {
  const parts = [];
  if (status) parts.push(`status:${String(status).toUpperCase()}`);
  if (vendor) parts.push(`vendor:"${String(vendor).replace(/"/g, '\\"')}"`);
  if (productType) parts.push(`product_type:"${String(productType).replace(/"/g, '\\"')}"`);
  if (tag) parts.push(`tag:"${String(tag).replace(/"/g, '\\"')}"`);
  if (collectionId) {
    const numericCol = String(collectionId).replace(/^gid:\/\/shopify\/Collection\//, '');
    parts.push(`collection_id:${numericCol}`);
  }
  if (query) parts.push(String(query));
  return parts.join(' ').trim();
}

// ---- LIST ----
router.get('/admin/products', async (req, res) => {
  try {
    const {
      query: q, status, vendor, productType, tag, collectionId,
      sortKey, reverse, first, after, before,
    } = req.query;

    const firstNum = Math.min(Math.max(parseInt(first, 10) || 25, 1), 250);
    const reverseBool = reverse === 'true' || reverse === '1';
    const sortKeyVal = sortKey ? String(sortKey).toUpperCase() : 'UPDATED_AT';
    const search = buildProductSearchQuery({ query: q, status, vendor, productType, tag, collectionId });

    const usingBefore = !!before;
    const variables = {
      query: search || null,
      sortKey: sortKeyVal,
      reverse: reverseBool,
    };
    let pagination;
    if (usingBefore) {
      variables.last = firstNum;
      variables.before = before;
      pagination = `last: $last, before: $before`;
    } else {
      variables.first = firstNum;
      if (after) variables.after = after;
      pagination = `first: $first${after ? ', after: $after' : ''}`;
    }

    const gqlVarDecls = [
      usingBefore ? '$last: Int!' : '$first: Int!',
      usingBefore ? '$before: String' : (after ? '$after: String' : null),
      '$query: String',
      '$sortKey: ProductSortKeys',
      '$reverse: Boolean',
    ].filter(Boolean).join(', ');

    const gql = `
      query ProductsList(${gqlVarDecls}) {
        products(${pagination}, query: $query, sortKey: $sortKey, reverse: $reverse) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          edges { cursor node { ${PRODUCT_LIST_FIELDS} } }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql, variables);
    const conn = data.products;
    const products = conn.edges.map(e => ({ cursor: e.cursor, ...flattenNode(e.node) }));
    res.json({ products, pageInfo: conn.pageInfo });
  } catch (err) { sendError(res, err); }
});

router.get('/admin/product/:id', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const product = await req.shopifyService.fetchProduct(id);
    res.json(product);
  } catch (err) { sendError(res, err); }
});

router.put('/admin/product/:id', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const result = await req.shopifyService.updateProduct(id, req.body || {});
    // refetch to be sure we have everything fresh
    const fresh = await req.shopifyService.fetchProduct(id);
    res.json({ success: true, product: fresh, _intermediate: result ? { id: result.id } : null });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/duplicate', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const newTitle = (req.body && req.body.newTitle) || 'Copy';
    const mutation = `
      mutation productDuplicate($productId: ID!, $newTitle: String!) {
        productDuplicate(productId: $productId, newTitle: $newTitle) {
          newProduct { id title handle status }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { productId, newTitle });
    if (data.productDuplicate.userErrors.length) {
      throw new BridgeError('productDuplicate rejected', { status: 422, code: 'USER_ERRORS', details: data.productDuplicate.userErrors });
    }
    res.json({ success: true, product: data.productDuplicate.newProduct });
  } catch (err) { sendError(res, err); }
});

router.delete('/admin/product/:id', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const mutation = `
      mutation productDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { input: { id: productId } });
    if (data.productDelete.userErrors.length) {
      throw new BridgeError('productDelete rejected', { status: 422, code: 'USER_ERRORS', details: data.productDelete.userErrors });
    }
    res.json({ success: true, deletedProductId: data.productDelete.deletedProductId });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product', async (req, res) => {
  try {
    const body = req.body || {};
    const input = {};
    for (const k of ['title', 'descriptionHtml', 'productType', 'vendor', 'status', 'tags', 'templateSuffix', 'handle', 'giftCard']) {
      if (body[k] !== undefined) input[k] = body[k];
    }
    if (Array.isArray(body.options)) {
      input.productOptions = body.options.map(o => ({
        name: o.name,
        values: (o.values || []).map(v => ({ name: v })),
      }));
    }
    const mutation = `
      mutation productCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product { id title handle status }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { input });
    if (data.productCreate.userErrors.length) {
      throw new BridgeError('productCreate rejected', { status: 422, code: 'USER_ERRORS', details: data.productCreate.userErrors });
    }
    let product = data.productCreate.product;
    if (Array.isArray(body.variants) && body.variants.length && product) {
      // productVariantCreate was removed. Bulk-create in one call instead.
      const variantsInput = body.variants.map(v => {
        const out = {};
        for (const k of ['price', 'compareAtPrice', 'inventoryPolicy', 'taxable', 'taxCode', 'optionValues']) {
          if (v[k] !== undefined) out[k] = v[k];
        }
        const inv = {};
        if (v.sku !== undefined) inv.sku = v.sku;
        if (v.barcode !== undefined) inv.barcode = v.barcode;
        if (v.tracked !== undefined) inv.tracked = v.tracked;
        if (Object.keys(inv).length) out.inventoryItem = inv;
        return out;
      });
      const vMut = `
        mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`;
      const vData = await req.shopifyService.graphqlRequest(vMut, { productId: product.id, variants: variantsInput });
      if (vData.productVariantsBulkCreate.userErrors.length) {
        throw new BridgeError('productVariantsBulkCreate rejected', { status: 422, code: 'USER_ERRORS', details: vData.productVariantsBulkCreate.userErrors });
      }
      product = await req.shopifyService.fetchProduct(product.id);
    }
    res.json({ success: true, product });
  } catch (err) { sendError(res, err); }
});

// ---- VARIANTS ----
router.get('/admin/product/:id/variants', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const product = await req.shopifyService.fetchProduct(id);
    res.json({ variants: product.variants || [] });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/variants', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const body = req.body || {};
    // Accept either { variants: [...] } or a single variant object as the body.
    const inputs = Array.isArray(body.variants) ? body.variants : [body];
    const variants = inputs.map(v => {
      const out = {};
      for (const k of ['price', 'compareAtPrice', 'inventoryPolicy', 'taxable', 'taxCode', 'optionValues']) {
        if (v[k] !== undefined) out[k] = v[k];
      }
      const inv = {};
      if (v.sku !== undefined) inv.sku = v.sku;
      if (v.barcode !== undefined) inv.barcode = v.barcode;
      if (v.tracked !== undefined) inv.tracked = v.tracked;
      if (Object.keys(inv).length) out.inventoryItem = inv;
      return out;
    });
    const mutation = `
      mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id title sku price }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { productId, variants });
    if (data.productVariantsBulkCreate.userErrors.length) {
      throw new BridgeError('productVariantsBulkCreate rejected', { status: 422, code: 'USER_ERRORS', details: data.productVariantsBulkCreate.userErrors });
    }
    res.json({ success: true, variants: data.productVariantsBulkCreate.productVariants });
  } catch (err) { sendError(res, err); }
});

router.put('/admin/variant/:id', async (req, res) => {
  try {
    const variantId = gid('ProductVariant', req.params.id);
    const variant = { ...(req.body || {}), id: variantId };
    const result = await req.shopifyService.updateVariant(variant);
    res.json({ success: true, variant: result });
  } catch (err) { sendError(res, err); }
});

router.delete('/admin/variant/:id', async (req, res) => {
  try {
    const variantId = gid('ProductVariant', req.params.id);
    // productVariantDelete was removed. productVariantsBulkDelete needs the parent productId.
    const lookup = await req.shopifyService.graphqlRequest(
      `query($id: ID!) { productVariant(id: $id) { product { id } } }`,
      { id: variantId },
    );
    const productId = lookup.productVariant && lookup.productVariant.product && lookup.productVariant.product.id;
    if (!productId) throw new BridgeError('Variant not found', { status: 404, code: 'NOT_FOUND' });
    const mutation = `
      mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          product { id }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { productId, variantsIds: [variantId] });
    if (data.productVariantsBulkDelete.userErrors.length) {
      throw new BridgeError('productVariantsBulkDelete rejected', { status: 422, code: 'USER_ERRORS', details: data.productVariantsBulkDelete.userErrors });
    }
    res.json({ success: true, deletedProductVariantId: variantId });
  } catch (err) { sendError(res, err); }
});

// ---- MEDIA ----
router.post('/admin/product/:id/media', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const images = (req.body && req.body.images) || [];
    const result = await req.shopifyService.appendProductImages(productId, images);
    res.json({ success: true, media: result });
  } catch (err) { sendError(res, err); }
});

router.put('/admin/product/:id/media/:mediaId', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const mediaId = gid('MediaImage', req.params.mediaId);
    // service.updateProductImage expects { id, altText?, src? } (image API)
    // Use productUpdateMedia which accepts MediaImage gids and altText.
    const mutation = `
      mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id alt image { url } } }
          mediaUserErrors { field message }
        }
      }
    `;
    const mediaInput = { id: mediaId };
    if (req.body && req.body.altText !== undefined) mediaInput.alt = req.body.altText;
    if (req.body && req.body.src !== undefined) mediaInput.previewImageSource = req.body.src;
    const data = await req.shopifyService.graphqlRequest(mutation, { productId, media: [mediaInput] });
    if (data.productUpdateMedia.mediaUserErrors.length) {
      throw new BridgeError('productUpdateMedia rejected', { status: 422, code: 'USER_ERRORS', details: data.productUpdateMedia.mediaUserErrors });
    }
    res.json({ success: true, media: data.productUpdateMedia.media[0] || null });
  } catch (err) { sendError(res, err); }
});

router.delete('/admin/product/:id/media', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const mediaIds = (req.body && req.body.mediaIds) || [];
    const result = await req.shopifyService.deleteProductMedia(productId, mediaIds);
    res.json({ success: true, deletedMediaIds: result });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/media/reorder', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const moves = (req.body && req.body.moves) || [];
    const mutation = `
      mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          job { id }
          mediaUserErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { id, moves });
    if (data.productReorderMedia.mediaUserErrors.length) {
      throw new BridgeError('productReorderMedia rejected', { status: 422, code: 'USER_ERRORS', details: data.productReorderMedia.mediaUserErrors });
    }
    res.json({ success: true, job: data.productReorderMedia.job });
  } catch (err) { sendError(res, err); }
});

// ---- METAFIELDS ----
router.get('/admin/product/:id/metafields', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const gql = `
      query($id: ID!) {
        product(id: $id) {
          metafields(first: 50) {
            edges { node { id namespace key value type description } }
          }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql, { id });
    const metafields = flattenEdges(data.product?.metafields?.edges || []);
    res.json({ metafields });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/metafields', async (req, res) => {
  try {
    const ownerId = gid('Product', req.params.id);
    const input = ((req.body && req.body.metafields) || []).map(m => ({
      ownerId,
      namespace: m.namespace,
      key: m.key,
      value: String(m.value),
      type: m.type || 'single_line_text_field',
    }));
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value type }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { metafields: input });
    if (data.metafieldsSet.userErrors.length) {
      throw new BridgeError('metafieldsSet rejected', { status: 422, code: 'USER_ERRORS', details: data.metafieldsSet.userErrors });
    }
    res.json({ success: true, metafields: data.metafieldsSet.metafields });
  } catch (err) { sendError(res, err); }
});

router.delete('/admin/metafield/:id', async (req, res) => {
  try {
    const id = gid('Metafield', req.params.id);
    const mutation = `
      mutation metafieldDelete($input: MetafieldDeleteInput!) {
        metafieldDelete(input: $input) {
          deletedId
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { input: { id } });
    if (data.metafieldDelete.userErrors.length) {
      throw new BridgeError('metafieldDelete rejected', { status: 422, code: 'USER_ERRORS', details: data.metafieldDelete.userErrors });
    }
    res.json({ success: true, deletedId: data.metafieldDelete.deletedId });
  } catch (err) { sendError(res, err); }
});

// ---- COLLECTIONS ----
router.get('/admin/collections', async (req, res) => {
  try {
    const { query: q, first, after, sortKey, reverse } = req.query;
    const firstNum = Math.min(Math.max(parseInt(first, 10) || 25, 1), 250);
    const variables = {
      first: firstNum,
      query: q || null,
      sortKey: sortKey ? String(sortKey).toUpperCase() : 'UPDATED_AT',
      reverse: reverse === 'true' || reverse === '1',
    };
    if (after) variables.after = after;
    const gql = `
      query Collections($first: Int!, ${after ? '$after: String,' : ''} $query: String, $sortKey: CollectionSortKeys, $reverse: Boolean) {
        collections(first: $first${after ? ', after: $after' : ''}, query: $query, sortKey: $sortKey, reverse: $reverse) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          edges { cursor node { id title handle updatedAt productsCount { count } image { url } } }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql, variables);
    const conn = data.collections;
    const collections = conn.edges.map(e => ({ cursor: e.cursor, ...flattenNode(e.node) }));
    res.json({ collections, pageInfo: conn.pageInfo });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/collections/add', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const collectionIds = (req.body && req.body.collectionIds) || [];
    const results = [];
    for (const cid of collectionIds) {
      const collectionId = gid('Collection', cid);
      const mutation = `
        mutation collectionAddProductsV2($id: ID!, $productIds: [ID!]!) {
          collectionAddProductsV2(id: $id, productIds: $productIds) {
            job { id }
            userErrors { field message }
          }
        }
      `;
      const data = await req.shopifyService.graphqlRequest(mutation, { id: collectionId, productIds: [productId] });
      results.push({ collectionId, userErrors: data.collectionAddProductsV2.userErrors, job: data.collectionAddProductsV2.job });
    }
    res.json({ success: true, results });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/collections/remove', async (req, res) => {
  try {
    const productId = gid('Product', req.params.id);
    const collectionIds = (req.body && req.body.collectionIds) || [];
    const results = [];
    for (const cid of collectionIds) {
      const collectionId = gid('Collection', cid);
      const mutation = `
        mutation collectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) {
            job { id }
            userErrors { field message }
          }
        }
      `;
      const data = await req.shopifyService.graphqlRequest(mutation, { id: collectionId, productIds: [productId] });
      results.push({ collectionId, userErrors: data.collectionRemoveProducts.userErrors, job: data.collectionRemoveProducts.job });
    }
    res.json({ success: true, results });
  } catch (err) { sendError(res, err); }
});

// ---- PUBLICATIONS / PUBLISH ----
router.get('/admin/publications', async (req, res) => {
  try {
    const gql = `
      query {
        publications(first: 25) {
          edges { node { id name } }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql);
    res.json({ publications: flattenEdges(data.publications.edges) });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/publish', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const publicationIds = (req.body && req.body.publicationIds) || [];
    const input = publicationIds.map(pid => ({ publicationId: pid }));
    const mutation = `
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { availablePublicationsCount { count } }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { id, input });
    if (data.publishablePublish.userErrors.length) {
      throw new BridgeError('publishablePublish rejected', { status: 422, code: 'USER_ERRORS', details: data.publishablePublish.userErrors });
    }
    res.json({ success: true });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/product/:id/unpublish', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const publicationIds = (req.body && req.body.publicationIds) || [];
    const input = publicationIds.map(pid => ({ publicationId: pid }));
    const mutation = `
      mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          publishable { availablePublicationsCount { count } }
          userErrors { field message }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(mutation, { id, input });
    if (data.publishableUnpublish.userErrors.length) {
      throw new BridgeError('publishableUnpublish rejected', { status: 422, code: 'USER_ERRORS', details: data.publishableUnpublish.userErrors });
    }
    res.json({ success: true });
  } catch (err) { sendError(res, err); }
});

// ---- INVENTORY ----
router.get('/admin/product/:id/inventory', async (req, res) => {
  try {
    const id = gid('Product', req.params.id);
    const gql = `
      query($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            edges { node {
              id title sku
              inventoryItem {
                id
                inventoryLevels(first: 20) {
                  edges { node { id quantities(names: ["available"]) { name quantity } location { id name } } }
                }
              }
            } }
          }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql, { id });
    const variants = (data.product?.variants?.edges || []).map(e => {
      const v = e.node;
      const item = v.inventoryItem;
      const levels = (item?.inventoryLevels?.edges || []).map(le => {
        const ln = le.node;
        const availQ = (ln.quantities || []).find(q => q.name === 'available');
        return {
          inventoryLevelId: ln.id,
          locationId: ln.location.id,
          locationName: ln.location.name,
          available: availQ ? availQ.quantity : 0,
        };
      });
      return {
        variantId: v.id,
        title: v.title,
        sku: v.sku,
        inventoryItemId: item?.id || null,
        levels,
      };
    });
    res.json({ variants });
  } catch (err) { sendError(res, err); }
});

router.post('/admin/inventory/adjust', async (req, res) => {
  try {
    const { reason = 'correction', changes = [] } = req.body || {};
    const mutation = `
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup { id reason }
          userErrors { field message }
        }
      }
    `;
    const input = {
      reason,
      name: 'available',
      changes: changes.map(c => ({
        delta: Number(c.delta),
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
      })),
    };
    const data = await req.shopifyService.graphqlRequest(mutation, { input });
    if (data.inventoryAdjustQuantities.userErrors.length) {
      throw new BridgeError('inventoryAdjustQuantities rejected', { status: 422, code: 'USER_ERRORS', details: data.inventoryAdjustQuantities.userErrors });
    }
    res.json({ success: true, group: data.inventoryAdjustQuantities.inventoryAdjustmentGroup });
  } catch (err) { sendError(res, err); }
});

router.get('/admin/locations', async (req, res) => {
  try {
    const gql = `
      query {
        locations(first: 20) {
          edges { node { id name } }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql);
    res.json({ locations: flattenEdges(data.locations.edges) });
  } catch (err) { sendError(res, err); }
});

// ---- SHOP ----
router.get('/admin/shop', async (req, res) => {
  try {
    const gql = `
      query {
        shop {
          name
          email
          currencyCode
          myshopifyDomain
          primaryDomain { url }
          plan { displayName }
        }
      }
    `;
    const data = await req.shopifyService.graphqlRequest(gql);
    res.json({ shop: data.shop });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
