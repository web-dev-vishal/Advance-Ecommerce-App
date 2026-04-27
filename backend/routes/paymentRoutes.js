const express = require('express');
const { createOrder, confirmPayment, verifyPayment } = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/order', protect, createOrder);
router.post('/confirm', protect, confirmPayment);
router.post('/verify', protect, verifyPayment);

module.exports = router;
