require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const productRoutes = require('./src/routes/productRoutes');
const productAdminRoutes = require('./src/routes/productAdminRoutes');
const authRoutes = require('./src/routes/authRoutes');
const docsRoutes = require('./src/routes/docsRoutes');
require('./src/registerSpec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Enable CORS so the React frontend can consume this API automatically without issues
app.use(cors());

// READ_ONLY mode: when set (e.g. on Render), block every mutating request.
// Locally leave READ_ONLY unset and everything works normally.
const READ_ONLY = String(process.env.READ_ONLY || '').toLowerCase() === 'true';
if (READ_ONLY) {
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return res.status(403).json({
      error: true,
      code: 'READ_ONLY',
      message: 'This deployment is read-only. Mutating requests are disabled.',
    });
  });
}

// New product bridge endpoints (the focus of this build)
app.use('/api', productRoutes);

// Expanded admin endpoints (Shopify-parity dashboard)
app.use('/api', productAdminRoutes);

// API self-documentation
app.use('/api', docsRoutes);

// Auth flow
app.use('/', authRoutes);



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

// Process-level safety nets — Node 20 kills the process on unhandled rejections by default.
// Log loudly but keep the server running so a single bad request can't take down the API.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
