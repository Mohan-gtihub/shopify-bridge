const express = require('express');
const { getSpec, convertToOpenAPI } = require('../apiSpec');
const { getSession } = require('../utils/storage');

const router = express.Router();

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

router.get('/_docs', (_req, res) => {
  const session = getSession();
  res.json({
    endpoints: getSpec(),
    generatedAt: new Date().toISOString(),
    shop: session ? session.shop : null,
    apiVersion: API_VERSION,
  });
});

router.get('/openapi.json', (req, res) => {
  const host = req.get('host');
  const proto = req.protocol;
  const spec = convertToOpenAPI(`${proto}://${host}`);
  res.json(spec);
});

module.exports = router;
