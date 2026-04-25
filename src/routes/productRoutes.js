const express = require('express');
const { listProducts, updateProduct, throttleStatus, analytics } = require('../controllers/productsController');

const router = express.Router();

router.get('/products', listProducts);
router.post('/product/update', updateProduct);
router.get('/throttle', throttleStatus);
router.get('/analytics', analytics);

module.exports = router;
