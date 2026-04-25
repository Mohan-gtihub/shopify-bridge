const axios = require('axios');
const { flattenEdges, flattenNode } = require('../utils/transformer');

const PRODUCT_FIELDS = `
  id
  title
  handle
  descriptionHtml
  productType
  vendor
  status
  tags
  templateSuffix
  onlineStoreUrl
  onlineStorePreviewUrl
  totalInventory
  tracksInventory
  createdAt
  updatedAt
  publishedAt
  seo { title description }
  featuredImage { id url altText width height }
  images(first: 50) {
    edges { node { id url altText width height } }
  }
  media(first: 50) {
    edges { node {
      ... on MediaImage { id alt mediaContentType image { url width height } }
      ... on Video { id alt mediaContentType sources { url mimeType format height width } }
      ... on ExternalVideo { id alt mediaContentType originUrl }
      ... on Model3d { id alt mediaContentType sources { url mimeType format } }
    } }
  }
  options { id name position values }
  variants(first: 100) {
    edges { node {
      id title sku barcode price compareAtPrice position
      inventoryPolicy
      taxable taxCode
      selectedOptions { name value }
      image { id url altText }
    } }
  }
  metafields(first: 50) {
    edges { node { id namespace key value type description } }
  }
  collections(first: 20) {
    edges { node { id title handle } }
  }
`;

const COLLECTION_FIELDS = `
  id
  title
  handle
  descriptionHtml
  updatedAt
  templateSuffix
  sortOrder
  seo { title description }
  image { id url altText width height }
  metafields(first: 50) {
    edges { node { id namespace key value type description } }
  }
  ruleSet {
    appliedDisjunctively
    rules { column relation condition }
  }
  products(first: 50) {
    edges { node { id title handle } }
  }
`;

class ShopifyService {
  constructor(shop, token) {
    this.shop = shop;
    this.token = token;
    // 2025-01 is the first stable version where the new variant model
    // (productVariantsBulkCreate/Update/Delete + ProductSet) is fully required.
    // productVariantCreate/Update/Delete and productImageUpdate are gone here.
    this.baseURL = `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION || '2025-01'}/graphql.json`;
    this.headers = {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    };
  }

  async graphqlRequest(query, variables = {}) {
    try {
      const response = await axios.post(
        this.baseURL,
        { query, variables },
        { headers: this.headers }
      );
      if (response.data.errors) {
        console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
        throw new Error('Shopify GraphQL Error: ' + JSON.stringify(response.data.errors));
      }
      return response.data.data;
    } catch (err) {
      console.error('Request failed:', err.response?.data || err.message);
      throw err;
    }
  }

  async paginate(rootKey, query) {
    const all = [];
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await this.graphqlRequest(query, { cursor });
      const conn = data[rootKey];
      all.push(...flattenEdges(conn));
      hasNextPage = conn.pageInfo.hasNextPage;
      cursor = conn.edges.length ? conn.edges[conn.edges.length - 1].cursor : null;
      if (!cursor) hasNextPage = false;
    }
    return all;
  }

  fetchAllProducts() {
    return this.paginate('products', `
      query getProducts($cursor: String) {
        products(first: 25, after: $cursor) {
          pageInfo { hasNextPage }
          edges { cursor node { ${PRODUCT_FIELDS} } }
        }
      }
    `);
  }

  fetchAllCollections() {
    return this.paginate('collections', `
      query getCollections($cursor: String) {
        collections(first: 25, after: $cursor) {
          pageInfo { hasNextPage }
          edges { cursor node { ${COLLECTION_FIELDS} } }
        }
      }
    `);
  }

  async fetchProduct(id) {
    const data = await this.graphqlRequest(
      `query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
      { id }
    );
    return flattenNode(data.product);
  }

  async fetchCollection(id) {
    const data = await this.graphqlRequest(
      `query($id: ID!) { collection(id: $id) { ${COLLECTION_FIELDS} } }`,
      { id }
    );
    return flattenNode(data.collection);
  }

  buildProductInput(id, data) {
    const input = { id };
    const passthrough = ['title', 'handle', 'productType', 'vendor', 'status', 'tags', 'templateSuffix', 'giftCard'];
    for (const k of passthrough) if (data[k] !== undefined) input[k] = data[k];
    if (data.description !== undefined) input.descriptionHtml = data.description;
    if (data.descriptionHtml !== undefined) input.descriptionHtml = data.descriptionHtml;
    if (data.seo) {
      input.seo = {};
      if (data.seo.title !== undefined) input.seo.title = data.seo.title;
      if (data.seo.description !== undefined) input.seo.description = data.seo.description;
    }
    // Note: ProductInput.metafields was removed in newer Admin API versions.
    // updateProduct() handles metafields via a separate metafieldsSet call.
    return input;
  }

  buildCollectionInput(id, data) {
    const input = { id };
    const passthrough = ['title', 'handle', 'templateSuffix', 'sortOrder'];
    for (const k of passthrough) if (data[k] !== undefined) input[k] = data[k];
    if (data.description !== undefined) input.descriptionHtml = data.description;
    if (data.descriptionHtml !== undefined) input.descriptionHtml = data.descriptionHtml;
    if (data.seo) {
      input.seo = {};
      if (data.seo.title !== undefined) input.seo.title = data.seo.title;
      if (data.seo.description !== undefined) input.seo.description = data.seo.description;
    }
    if (data.image) {
      input.image = {};
      if (data.image.src !== undefined) input.image.src = data.image.src;
      if (data.image.url !== undefined) input.image.src = data.image.url;
      if (data.image.altText !== undefined) input.image.altText = data.image.altText;
    }
    // CollectionInput.metafields was also removed; handled via metafieldsSet in updateCollection.
    return input;
  }

  async setMetafields(ownerId, metafields) {
    if (!Array.isArray(metafields) || !metafields.length) return [];
    const input = metafields.map(m => ({
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
    const result = await this.graphqlRequest(mutation, { metafields: input });
    if (result.metafieldsSet.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.metafieldsSet.userErrors));
    }
    return result.metafieldsSet.metafields;
  }

  async updateProduct(id, data) {
    const input = this.buildProductInput(id, data);
    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { ${PRODUCT_FIELDS} }
          userErrors { field message }
        }
      }
    `;
    const result = await this.graphqlRequest(mutation, { input });
    if (result.productUpdate.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.productUpdate.userErrors));
    }
    let product = result.productUpdate.product;

    // Optional image ops
    if (Array.isArray(data.imagesToCreate) && data.imagesToCreate.length) {
      await this.appendProductImages(id, data.imagesToCreate);
    }
    if (Array.isArray(data.imagesToUpdate) && data.imagesToUpdate.length) {
      for (const img of data.imagesToUpdate) await this.updateProductImage(id, img);
    }
    if (Array.isArray(data.imagesToDelete) && data.imagesToDelete.length) {
      await this.deleteProductMedia(id, data.imagesToDelete);
    }

    // Optional variant updates — bulk in a single call (faster + atomic per product).
    if (Array.isArray(data.variants) && data.variants.length) {
      const bulk = data.variants.map(v => {
        const out = { id: v.id };
        for (const k of ['price', 'compareAtPrice', 'inventoryPolicy', 'taxable', 'taxCode']) {
          if (v[k] !== undefined) out[k] = v[k];
        }
        const inv = {};
        if (v.sku !== undefined) inv.sku = v.sku;
        if (v.barcode !== undefined) inv.barcode = v.barcode;
        if (v.tracked !== undefined) inv.tracked = v.tracked;
        if (Object.keys(inv).length) out.inventoryItem = inv;
        return out;
      });
      const mut = `
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`;
      const r = await this.graphqlRequest(mut, { productId: id, variants: bulk });
      if (r.productVariantsBulkUpdate.userErrors.length) {
        throw new Error(JSON.stringify(r.productVariantsBulkUpdate.userErrors));
      }
    }

    // Optional metafields — must be a separate metafieldsSet since ProductInput.metafields is removed.
    if (Array.isArray(data.metafields) && data.metafields.length) {
      await this.setMetafields(id, data.metafields);
    }

    if (data.imagesToCreate || data.imagesToUpdate || data.imagesToDelete || data.variants || data.metafields) {
      product = await this.fetchProduct(id);
    }
    return flattenNode(product);
  }

  async updateCollection(id, data) {
    const input = this.buildCollectionInput(id, data);
    const mutation = `
      mutation collectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { ${COLLECTION_FIELDS} }
          userErrors { field message }
        }
      }
    `;
    const result = await this.graphqlRequest(mutation, { input });
    if (result.collectionUpdate.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.collectionUpdate.userErrors));
    }
    if (Array.isArray(data.metafields) && data.metafields.length) {
      await this.setMetafields(id, data.metafields);
      return await this.fetchCollection(id);
    }
    return flattenNode(result.collectionUpdate.collection);
  }

  async appendProductImages(productId, images) {
    const media = images.map(img => ({
      originalSource: img.src || img.url,
      alt: img.altText || img.alt || '',
      mediaContentType: 'IMAGE',
    }));
    const mutation = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id alt image { url } } }
          mediaUserErrors { field message }
        }
      }
    `;
    const result = await this.graphqlRequest(mutation, { productId, media });
    if (result.productCreateMedia.mediaUserErrors.length > 0) {
      throw new Error(JSON.stringify(result.productCreateMedia.mediaUserErrors));
    }
    return result.productCreateMedia.media;
  }

  async updateProductImage(productId, image) {
    // productImageUpdate was removed. Use productUpdateMedia, which accepts
    // a MediaImage gid + alt text. Replacing the underlying file isn't
    // supported by this mutation — callers that want a new file should
    // delete + re-create the media instead.
    const mutation = `
      mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id alt image { url altText } } }
          mediaUserErrors { field message }
        }
      }
    `;
    const mediaInput = { id: image.id };
    if (image.altText !== undefined) mediaInput.alt = image.altText;
    if (image.src !== undefined) mediaInput.previewImageSource = image.src;
    const result = await this.graphqlRequest(mutation, { productId, media: [mediaInput] });
    if (result.productUpdateMedia.mediaUserErrors.length > 0) {
      throw new Error(JSON.stringify(result.productUpdateMedia.mediaUserErrors));
    }
    return result.productUpdateMedia.media[0] || null;
  }

  async deleteProductMedia(productId, mediaIds) {
    const mutation = `
      mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          mediaUserErrors { field message }
        }
      }
    `;
    const result = await this.graphqlRequest(mutation, { productId, mediaIds });
    if (result.productDeleteMedia.mediaUserErrors.length > 0) {
      throw new Error(JSON.stringify(result.productDeleteMedia.mediaUserErrors));
    }
    return result.productDeleteMedia.deletedMediaIds;
  }

  async updateVariant(variant) {
    let productId = variant.productId;
    if (!productId) {
      // productVariantsBulkUpdate needs the parent product gid; look it up from the variant.
      const lookup = await this.graphqlRequest(
        `query($id: ID!) { productVariant(id: $id) { product { id } } }`,
        { id: variant.id },
      );
      productId = lookup.productVariant && lookup.productVariant.product && lookup.productVariant.product.id;
      if (!productId) {
        throw new Error(`updateVariant: could not resolve parent product for variant ${variant.id}`);
      }
    }
    const v = { id: variant.id };
    // ProductVariantsBulkInput layout (2025-01):
    //   top-level: price, compareAtPrice, inventoryPolicy, taxable, taxCode, optionValues, mediaId
    //   inventoryItem: sku, barcode, tracked, cost, weight, harmonizedSystemCode, countryCodeOfOrigin, etc.
    const topLevel = ['price', 'compareAtPrice', 'inventoryPolicy', 'taxable', 'taxCode'];
    for (const k of topLevel) if (variant[k] !== undefined) v[k] = variant[k];
    const inventoryItem = {};
    if (variant.sku !== undefined) inventoryItem.sku = variant.sku;
    if (variant.barcode !== undefined) inventoryItem.barcode = variant.barcode;
    if (variant.tracked !== undefined) inventoryItem.tracked = variant.tracked;
    if (Object.keys(inventoryItem).length) v.inventoryItem = inventoryItem;
    const mutation = `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id title sku price compareAtPrice barcode }
          userErrors { field message }
        }
      }
    `;
    const result = await this.graphqlRequest(mutation, { productId, variants: [v] });
    if (result.productVariantsBulkUpdate.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.productVariantsBulkUpdate.userErrors));
    }
    return result.productVariantsBulkUpdate.productVariants[0] || null;
  }
}

module.exports = ShopifyService;
