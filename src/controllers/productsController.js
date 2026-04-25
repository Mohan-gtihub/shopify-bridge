const { getSession } = require('../utils/storage');
const { buildClient } = require('../services/shopifyQuery');
const { buildService } = require('../services/productService');
const { sendError, BridgeError } = require('../utils/errors');

function getServiceAndClient() {
  const session = getSession();
  if (!session || !session.token || !session.shop) {
    throw new BridgeError('No active Shopify session — visit /auth or set SHOPIFY_ACCESS_TOKEN + SHOP', {
      status: 401,
      code: 'NO_SESSION',
    });
  }
  const client = buildClient({ shop: session.shop, token: session.token });
  return { service: buildService({ shopifyQuery: client.shopifyQuery }), client };
}

async function listProducts(req, res) {
  try {
    const { limit, sort, sortKey, reverse } = req.query;
    const { service, client } = getServiceAndClient();
    const products = await service.listProducts({
      limit: limit !== undefined ? limit : 10,
      sortKey: sortKey || sort || 'TITLE',
      reverse,
    });
    res.json({ products, throttle: client.getLastCost() });
  } catch (err) {
    sendError(res, err);
  }
}

async function updateProduct(req, res) {
  try {
    const { service, client } = getServiceAndClient();
    const result = await service.updateProduct(req.body || {});
    res.json({ ...result, throttle: client.getLastCost() });
  } catch (err) {
    sendError(res, err);
  }
}

async function throttleStatus(_req, res) {
  try {
    const { client } = getServiceAndClient();
    res.json({ throttle: client.getLastCost() });
  } catch (err) {
    sendError(res, err);
  }
}

async function analytics(_req, res) {
  try {
    const { client } = getServiceAndClient();
    const history = client.getHistory();
    const totalCalls = history.length;
    const totalActualCost = history.reduce((s, h) => s + (h.actualQueryCost || 0), 0);
    const totalRequestedCost = history.reduce((s, h) => s + (h.requestedQueryCost || 0), 0);
    const avgDurationMs = totalCalls
      ? Math.round(history.reduce((s, h) => s + (h.durationMs || 0), 0) / totalCalls)
      : 0;

    // Per-operation breakdown
    const byOp = {};
    for (const h of history) {
      const key = `${h.opKind}:${h.opName}`;
      if (!byOp[key]) byOp[key] = { opKind: h.opKind, opName: h.opName, calls: 0, actualCost: 0, totalDurationMs: 0 };
      byOp[key].calls += 1;
      byOp[key].actualCost += h.actualQueryCost || 0;
      byOp[key].totalDurationMs += h.durationMs || 0;
    }
    const operations = Object.values(byOp)
      .map((o) => ({ ...o, avgDurationMs: Math.round(o.totalDurationMs / o.calls) }))
      .sort((a, b) => b.actualCost - a.actualCost);

    res.json({
      throttle: client.getLastCost(),
      summary: { totalCalls, totalActualCost, totalRequestedCost, avgDurationMs },
      operations,
      history,
    });
  } catch (err) {
    sendError(res, err);
  }
}

module.exports = { listProducts, updateProduct, throttleStatus, analytics };
