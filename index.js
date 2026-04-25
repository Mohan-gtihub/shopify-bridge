require('dotenv').config();
const path = require('path');
const express = require('express');

const productRoutes = require('./src/routes/productRoutes');
const productAdminRoutes = require('./src/routes/productAdminRoutes');
const docsRoutes = require('./src/routes/docsRoutes');
require('./src/registerSpec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// API key guard — protects all /api routes from unauthenticated public access
app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: true, message: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  next();
});

// Auth guard (already implemented above)

// New product bridge endpoints (the focus of this build)
app.use('/api', productRoutes);

// Expanded admin endpoints (Shopify-parity dashboard)
app.use('/api', productAdminRoutes);

// API self-documentation
app.use('/api', docsRoutes);



// Static dashboard
app.use(express.static(path.join(__dirname, 'public')));

// JSON 404 for unmatched API routes (must come after route registration)
app.use('/api', (req, res) => {
  res.status(404).json({ error: true, message: `No such API route: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
});

// Last-resort error handler — keeps response shape consistent
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: true, message: err.message || 'Internal error', code: 'UNHANDLED' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
