const axios = require('axios');
const https = require('https');
const { BridgeError } = require('../utils/errors');

// Single shared HTTPS agent across all clients in this process.
// Enables TCP+TLS connection reuse to *.myshopify.com — typically saves
// 100–300ms per request after the first one.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });

/**
 * Reusable Shopify GraphQL Admin API client.
 *
 * Responsibilities:
 *  - Attach X-Shopify-Access-Token + Content-Type headers
 *  - Parse and validate JSON
 *  - Surface GraphQL `errors` and `userErrors` consistently
 *  - Track throttleStatus and throttle the *next* request when the
 *    bucket is running low (currentlyAvailable < 100)
 *  - Retry on THROTTLED extension code with exponential backoff
 *
 * The throttling logic is global per-shop (one bucket per access token),
 * so the gate is held on the module-scoped `gateBy` map.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const LOW_BUCKET_THRESHOLD = 100;
const LOW_BUCKET_DELAY_MS = 1000;
const MAX_RETRIES = 3;

// shop -> Promise that resolves when the next call may proceed
const gateBy = new Map();
// shop -> latest throttle telemetry from Shopify (cost.throttleStatus + lastQueryCost)
const lastCostBy = new Map();
// shop -> ring buffer of recent calls (for the Analytics tab)
const historyBy = new Map();
const HISTORY_LIMIT = 200;
// (shop|token) -> built client. Memoized so concurrent requests share the
// in-flight dedupe map and the keep-alive socket pool.
const clientCache = new Map();

function getLastCost(shop) {
  return lastCostBy.get(shop) || null;
}

function getHistory(shop) {
  return historyBy.get(shop) || [];
}

function pushHistory(shop, entry) {
  let buf = historyBy.get(shop);
  if (!buf) { buf = []; historyBy.set(shop, buf); }
  buf.push(entry);
  if (buf.length > HISTORY_LIMIT) buf.splice(0, buf.length - HISTORY_LIMIT);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getGate(shop) {
  return gateBy.get(shop) || Promise.resolve();
}

function setGate(shop, ms) {
  const next = getGate(shop).then(() => sleep(ms));
  gateBy.set(shop, next);
  // Auto-clear once the wait elapses so the map doesn't grow unbounded
  next.finally(() => {
    if (gateBy.get(shop) === next) gateBy.delete(shop);
  });
}

function buildClient({ shop, token }) {
  if (!shop) throw new BridgeError('Shopify shop domain is required', { status: 500, code: 'CONFIG_MISSING_SHOP' });
  if (!token) throw new BridgeError('Shopify access token is required', { status: 401, code: 'CONFIG_MISSING_TOKEN' });

  const cacheKey = `${shop}::${token}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  // One axios instance per (shop, token) so headers + agent are configured once.
  const http = axios.create({
    baseURL: url,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
    httpsAgent,
    validateStatus: () => true,
  });

  // In-flight de-duplication: identical (query+vars) issued concurrently
  // share a single Shopify call. Keyed by JSON of the request body.
  const inFlight = new Map();

  /**
   * Execute a GraphQL request. Returns the `data` portion of the response.
   * Throws BridgeError on any failure.
   *
   * Behavior:
   *  - Concurrent identical (query, variables) calls share one upstream request.
   *  - Single retry counter (MAX_RETRIES) covers 429 + 5xx + GraphQL THROTTLED.
   *  - History records the *real* terminal status: ok | error | throttled.
   *  - Throttle gate is set after every response based on bucket telemetry.
   */
  async function shopifyQuery(query, variables = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new BridgeError('GraphQL query must be a non-empty string', { status: 400, code: 'BAD_QUERY' });
    }

    const dedupeKey = JSON.stringify({ query, variables });
    const existing = inFlight.get(dedupeKey);
    if (existing) return existing;

    const promise = runOnce(query, variables);
    inFlight.set(dedupeKey, promise);
    promise.finally(() => inFlight.delete(dedupeKey));
    return promise;
  }

  async function runOnce(query, variables) {
    // Operation name + kind for analytics labeling
    const m = query.match(/\b(query|mutation)\s+(\w+)/);
    const opKind = m ? m[1] : 'query';
    const opName = m ? m[2] : 'anonymous';
    const startedAt = Date.now();

    let attempts = 0;
    let lastCostSnapshot = null;
    let lastThrottleStatus = null;

    while (true) {
      await getGate(shop);

      let response;
      try {
        response = await http.post('', { query, variables });
      } catch (err) {
        recordHistory({ opKind, opName, startedAt, cost: null, status: 'error', errorCode: 'UPSTREAM_NETWORK' });
        throw new BridgeError(`Shopify request failed: ${err.message}`, { status: 502, code: 'UPSTREAM_NETWORK' });
      }

      const { status, data, headers: respHeaders } = response;

      // 429 → retry with Retry-After
      if (status === 429) {
        if (attempts++ >= MAX_RETRIES) {
          recordHistory({ opKind, opName, startedAt, cost: null, status: 'throttled', errorCode: 'RATE_LIMITED' });
          throw new BridgeError('Shopify rate limit exceeded', { status: 429, code: 'RATE_LIMITED' });
        }
        const retryAfter = Number(respHeaders && respHeaders['retry-after']) || 2;
        setGate(shop, retryAfter * 1000);
        continue;
      }

      // Auth failures — no point retrying
      if (status === 401 || status === 403) {
        recordHistory({ opKind, opName, startedAt, cost: null, status: 'error', errorCode: 'UNAUTHORIZED' });
        const upstream = (data && (data.errors || data.error)) || null;
        throw new BridgeError(
          'Shopify rejected the access token. Check SHOPIFY_ACCESS_TOKEN in .env — it must start with shpat_ (custom app) or shpca_ (OAuth), and have read_products/write_products scopes for ' + shop + '.',
          { status, code: 'UNAUTHORIZED', details: upstream }
        );
      }

      // 5xx → retry with exponential backoff
      if (status >= 500) {
        if (attempts++ < MAX_RETRIES) {
          setGate(shop, 500 * Math.pow(2, attempts));
          continue;
        }
        recordHistory({ opKind, opName, startedAt, cost: null, status: 'error', errorCode: 'UPSTREAM_5XX' });
        throw new BridgeError(`Shopify upstream error (${status})`, { status: 502, code: 'UPSTREAM_5XX' });
      }

      if (!data || typeof data !== 'object') {
        recordHistory({ opKind, opName, startedAt, cost: null, status: 'error', errorCode: 'BAD_UPSTREAM_BODY' });
        throw new BridgeError('Invalid JSON from Shopify', { status: 502, code: 'BAD_UPSTREAM_BODY' });
      }

      // Always update throttle telemetry + gate, even if there are GraphQL errors
      const cost = data.extensions && data.extensions.cost;
      lastCostSnapshot = cost;
      lastThrottleStatus = cost && cost.throttleStatus;
      if (lastThrottleStatus) {
        lastCostBy.set(shop, {
          requestedQueryCost: cost.requestedQueryCost,
          actualQueryCost: cost.actualQueryCost,
          throttleStatus: { ...lastThrottleStatus },
          lowBucketThreshold: LOW_BUCKET_THRESHOLD,
          updatedAt: new Date().toISOString(),
        });
        if (typeof lastThrottleStatus.currentlyAvailable === 'number'
            && lastThrottleStatus.currentlyAvailable < LOW_BUCKET_THRESHOLD) {
          setGate(shop, LOW_BUCKET_DELAY_MS);
        }
      }

      // GraphQL-level errors (THROTTLED is retriable, others are terminal)
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const throttled = data.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled && attempts++ < MAX_RETRIES) {
          setGate(shop, LOW_BUCKET_DELAY_MS * Math.pow(2, attempts));
          continue;
        }
        recordHistory({
          opKind, opName, startedAt,
          cost: lastCostSnapshot,
          status: throttled ? 'throttled' : 'error',
          errorCode: 'GRAPHQL_ERROR',
        });
        throw new BridgeError('Shopify GraphQL error', {
          status: 502,
          code: 'GRAPHQL_ERROR',
          details: data.errors.map((e) => ({ message: e.message, path: e.path, code: e.extensions && e.extensions.code })),
        });
      }

      if (!data.data) {
        recordHistory({ opKind, opName, startedAt, cost: lastCostSnapshot, status: 'error', errorCode: 'EMPTY_RESPONSE' });
        throw new BridgeError('Shopify returned no data', { status: 502, code: 'EMPTY_RESPONSE' });
      }

      recordHistory({ opKind, opName, startedAt, cost: lastCostSnapshot, status: 'ok' });
      return data.data;
    }
  }

  function recordHistory({ opKind, opName, startedAt, cost, status, errorCode }) {
    const ts = cost && cost.throttleStatus;
    pushHistory(shop, {
      ts: new Date().toISOString(),
      opKind,
      opName,
      durationMs: Date.now() - startedAt,
      requestedQueryCost: cost ? cost.requestedQueryCost : null,
      actualQueryCost: cost ? cost.actualQueryCost : null,
      currentlyAvailable: ts ? ts.currentlyAvailable : null,
      maximumAvailable: ts ? ts.maximumAvailable : null,
      restoreRate: ts ? ts.restoreRate : null,
      status,
      errorCode: errorCode || null,
    });
  }

  const client = {
    shopifyQuery,
    shop,
    apiVersion: API_VERSION,
    getLastCost: () => getLastCost(shop),
    getHistory: () => getHistory(shop).slice(),
  };
  clientCache.set(cacheKey, client);
  return client;
}

module.exports = { buildClient, getLastCost, getHistory };
