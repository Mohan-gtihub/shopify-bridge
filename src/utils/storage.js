const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '../../.shopify_session.json');

function saveSession(shop, token) {
  const data = { shop, token, fetched_at: new Date().toISOString() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

function looksLikeAccessToken(t) {
  // Real Shopify Admin API tokens start with shpat_ (custom app) or shpca_ (OAuth).
  // shpss_ is a SHARED SECRET — never a valid X-Shopify-Access-Token.
  return typeof t === 'string' && (t.startsWith('shpat_') || t.startsWith('shpca_'));
}

function getSession() {
  // Prefer a static admin API token from .env (custom apps installed via Shopify admin).
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN || process.env.ADMIN_API_TOKEN;
  if (envToken && process.env.SHOP) {
    if (envToken.startsWith('shpss_')) {
      console.warn(
        '[storage] SHOPIFY_ACCESS_TOKEN looks like a shared secret (shpss_), not an access token. ' +
        'Shopify will reject it. Use a Custom App Admin API token (shpat_…) or run /auth to OAuth.'
      );
    } else if (!looksLikeAccessToken(envToken)) {
      console.warn('[storage] SHOPIFY_ACCESS_TOKEN does not look like a Shopify access token (expected shpat_ or shpca_ prefix).');
    }
    return { shop: process.env.SHOP, token: envToken, source: 'env' };
  }
  if (fs.existsSync(TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  }
  return null;
}

module.exports = { saveSession, getSession };
