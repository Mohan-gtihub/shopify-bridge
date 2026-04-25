const express = require('express');
const axios = require('axios');
const { saveSession, getSession } = require('../utils/storage');
const ShopifyService = require('../services/shopifyService');

const router = express.Router();

router.get('/auth', (req, res) => {
  const shop = req.query.shop || process.env.SHOP;
  if (!shop) return res.status(400).send('Missing shop parameter');

  // Add state for extra security against CSRF (optional but good practice)
  const state = Math.random().toString(36).substring(7);
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.CLIENT_ID}&scope=${process.env.SCOPES}&redirect_uri=${process.env.REDIRECT_URI}&state=${state}`;
  res.redirect(authUrl);
});

router.get('/api/status', async (req, res) => {
  const session = getSession();
  const host = req.get('host');
  const proto = req.protocol;
  const baseUrl = `${proto}://${host}`;

  const status = {
    connected: false,
    baseUrl,
    bridgeApiKey: process.env.BRIDGE_API_KEY,
    shop: session ? session.shop : null,
  };

  if (!session || !session.token) {
    status.reason = 'NO_SESSION';
    return res.json(status);
  }

  try {
    const service = new ShopifyService(session.shop, session.token);
    await service.graphqlRequest('{ shop { name } }');
    status.connected = true;
    status.fetchedAt = session.fetched_at;
    res.json(status);
  } catch (err) {
    status.reason = 'INVALID_TOKEN';
    status.error = err.message;
    res.json(status);
  }
});

router.get('/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing shop or code');

  try {
    const accessTokenUrl = `https://${shop}/admin/oauth/access_token`;
    const response = await axios.post(accessTokenUrl, {
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      code,
    });

    const { access_token } = response.data;
    saveSession(shop, access_token);

    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #f4f6f8;">
          <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center;">
            <h1 style="color: #008060;">Authentication Successful!</h1>
            <p>Your session has been saved to <code>.shopify_session.json</code>.</p>
            <a href="/" style="display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #008060; color: white; text-decoration: none; border-radius: 4px;">Go to Dashboard</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth Error:', err.response?.data || err.message);
    res.status(500).send('Authentication failed: ' + (err.response?.data?.error_description || err.message));
  }
});

module.exports = router;
