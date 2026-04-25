const { BridgeError } = require('../utils/errors');

/**
 * Product-domain service. Wraps the GraphQL client and exposes
 * normalized product data (no edges/node), plus update mutations.
 */

const ALLOWED_SORT_KEYS = new Set([
  'TITLE',
  'CREATED_AT',
  'UPDATED_AT',
  'PRODUCT_TYPE',
  'VENDOR',
  'INVENTORY_TOTAL',
  'PUBLISHED_AT',
  'ID',
  'RELEVANCE',
]);

const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, sortKey: $sortKey, reverse: $reverse) {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          productType
          vendor
          status
          tags
          createdAt
          updatedAt
          seo { title description }
          images(first: 3) {
            edges { node { id url altText } }
          }
          variants(first: 1) {
            edges { node { id price compareAtPrice sku } }
          }
        }
      }
    }
  }
`;

// Single mutation document: when both fields and price are being changed,
// productUpdate runs first, productVariantsBulkUpdate runs second, in one HTTP call.
// Note: productVariantUpdate was removed in newer Admin API versions; the bulk
// variant mutation is the supported replacement and works for single variants too.
const PRODUCT_AND_VARIANT_UPDATE = /* GraphQL */ `
  mutation ProductAndVariantUpdate(
    $productInput: ProductInput!
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productUpdate(input: $productInput) {
      product { id title descriptionHtml seo { title description } }
      userErrors { field message }
    }
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE_ONLY = /* GraphQL */ `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title descriptionHtml seo { title description } }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE_ONLY = /* GraphQL */ `
  mutation VariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

// Used only on the first update for a given product; the variant id is then
// cached and reused so subsequent updates skip this lookup.
const FIRST_VARIANT_QUERY = /* GraphQL */ `
  query FirstVariant($id: ID!) {
    product(id: $id) {
      variants(first: 1) { edges { node { id } } }
    }
  }
`;

// productId -> first variant gid (saves a query on every subsequent update)
const firstVariantCache = new Map();

function normalizeProduct(node) {
  if (!node) return null;
  const images = (node.images && node.images.edges ? node.images.edges : [])
    .map((e) => e.node && e.node.url)
    .filter(Boolean);
  const firstVariant = node.variants && node.variants.edges && node.variants.edges[0] && node.variants.edges[0].node;
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: node.descriptionHtml || '',
    productType: node.productType || null,
    vendor: node.vendor || null,
    status: node.status || null,
    tags: node.tags || [],
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || null,
    seo: {
      title: (node.seo && node.seo.title) || null,
      description: (node.seo && node.seo.description) || null,
    },
    images,
    price: firstVariant ? firstVariant.price : null,
    compareAtPrice: firstVariant ? firstVariant.compareAtPrice || null : null,
    sku: firstVariant ? firstVariant.sku || null : null,
    variantId: firstVariant ? firstVariant.id : null,
  };
}

function buildService({ shopifyQuery }) {
  /**
   * GET /api/products handler logic.
   * Validates and clamps inputs, then returns normalized products.
   */
  async function listProducts({ limit = 10, sortKey = 'TITLE', reverse = false } = {}) {
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new BridgeError('limit must be a positive integer', { status: 400, code: 'BAD_LIMIT' });
    }
    const first = Math.min(Math.floor(parsedLimit), 250);

    const upperSort = String(sortKey).toUpperCase();
    if (!ALLOWED_SORT_KEYS.has(upperSort)) {
      throw new BridgeError(`sortKey must be one of: ${[...ALLOWED_SORT_KEYS].join(', ')}`, {
        status: 400,
        code: 'BAD_SORT_KEY',
      });
    }

    const reverseBool = reverse === true || reverse === 'true' || reverse === 1 || reverse === '1';

    const data = await shopifyQuery(PRODUCTS_QUERY, {
      first,
      sortKey: upperSort,
      reverse: reverseBool,
    });

    const edges = (data.products && data.products.edges) || [];
    return edges.map((e) => normalizeProduct(e.node));
  }

  /**
   * POST /api/product/update handler logic.
   *
   * Optimizations vs naive impl:
   *  - Product fields and variant price update run in ONE GraphQL document
   *    when both are present (saves one round-trip).
   *  - First variant id is cached per product, so the 2nd+ price-only update
   *    on a product needs zero lookups.
   *  - No-op update (only id sent) returns immediately, never hits Shopify.
   */
  async function updateProduct(payload = {}) {
    const { id, title, description, price, seo } = payload;
    if (!id || typeof id !== 'string') {
      throw new BridgeError('id is required (gid://shopify/Product/...)', {
        status: 400,
        code: 'BAD_ID',
      });
    }

    const productId = id.startsWith('gid://') ? id : `gid://shopify/Product/${id}`;

    // Assemble productUpdate input
    const productInput = { id: productId };
    if (title !== undefined) productInput.title = String(title);
    if (description !== undefined) productInput.descriptionHtml = String(description);
    if (seo && typeof seo === 'object') {
      productInput.seo = {};
      if (seo.title !== undefined) productInput.seo.title = String(seo.title);
      if (seo.description !== undefined) productInput.seo.description = String(seo.description);
    }

    const hasProductFields = Object.keys(productInput).length > 1;
    const hasPrice = price !== undefined && price !== null && price !== '';

    if (!hasProductFields && !hasPrice) {
      return { success: true, product: null, variant: null, noop: true };
    }

    // Resolve first variant id only when price is being updated
    let variantId = null;
    if (hasPrice) {
      variantId = firstVariantCache.get(productId) || null;
      if (!variantId) {
        const lookup = await shopifyQuery(FIRST_VARIANT_QUERY, { id: productId });
        const edge = lookup.product && lookup.product.variants && lookup.product.variants.edges[0];
        if (!edge) {
          throw new BridgeError('Product has no variants to update price on', {
            status: 422,
            code: 'NO_VARIANT',
          });
        }
        variantId = edge.node.id;
        firstVariantCache.set(productId, variantId);
      }
    }

    // Single combined mutation when both kinds of updates are present
    if (hasProductFields && hasPrice) {
      const data = await shopifyQuery(PRODUCT_AND_VARIANT_UPDATE, {
        productInput,
        productId,
        variants: [{ id: variantId, price: String(price) }],
      });
      const pErrors = data.productUpdate.userErrors;
      const vErrors = data.productVariantsBulkUpdate.userErrors;
      if ((pErrors && pErrors.length) || (vErrors && vErrors.length)) {
        throw new BridgeError('Update rejected by Shopify', {
          status: 422,
          code: 'USER_ERRORS',
          details: { product: pErrors, variant: vErrors },
        });
      }
      return {
        success: true,
        product: data.productUpdate.product,
        variant: data.productVariantsBulkUpdate.productVariants[0] || null,
      };
    }

    if (hasProductFields) {
      const data = await shopifyQuery(PRODUCT_UPDATE_ONLY, { input: productInput });
      const errors = data.productUpdate.userErrors;
      if (errors && errors.length) {
        throw new BridgeError('productUpdate rejected by Shopify', {
          status: 422,
          code: 'USER_ERRORS',
          details: errors,
        });
      }
      return { success: true, product: data.productUpdate.product, variant: null };
    }

    // hasPrice only
    const data = await shopifyQuery(VARIANT_UPDATE_ONLY, {
      productId,
      variants: [{ id: variantId, price: String(price) }],
    });
    const errors = data.productVariantsBulkUpdate.userErrors;
    if (errors && errors.length) {
      throw new BridgeError('productVariantsBulkUpdate rejected by Shopify', {
        status: 422,
        code: 'USER_ERRORS',
        details: errors,
      });
    }
    return {
      success: true,
      product: null,
      variant: data.productVariantsBulkUpdate.productVariants[0] || null,
    };
  }

  return { listProducts, updateProduct };
}

module.exports = { buildService, normalizeProduct, ALLOWED_SORT_KEYS };
