'use strict';

const Razorpay = require('razorpay');
const crypto = require('crypto');
const Order = require('../models/Order');
const { getCache, setCache } = require('../utils/cache');
const { publishMessage } = require('../config/rabbitmq');

// ── Startup credential validation ─────────────────────────────────────────────

let credentialsValid = true;

if (!process.env.RAZORPAY_KEY_ID) {
  console.warn('[Startup] Missing required env var: RAZORPAY_KEY_ID');
  credentialsValid = false;
}
if (!process.env.RAZORPAY_KEY_SECRET) {
  console.warn('[Startup] Missing required env var: RAZORPAY_KEY_SECRET');
  credentialsValid = false;
}

// Single Razorpay instance created once at module load
const razorpay = credentialsValid
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

// ── createOrder ───────────────────────────────────────────────────────────────

const createOrder = async (req, res) => {
  if (!credentialsValid) {
    return res.status(503).json({ message: 'Payment service unavailable' });
  }

  const { orderId } = req.body;
  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ message: 'orderId is required' });
  }

  const userId = req.user._id;

  let order;
  try {
    order = await Order.findOne({ _id: orderId, userId });
  } catch (err) {
    return res.status(400).json({ message: 'orderId is required' });
  }

  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }

  if (order.status !== 'Pending') {
    return res.status(400).json({ message: 'Order is not in a payable state' });
  }

  const dedupKey = `payment:dedup:${userId}:${orderId}`;
  const cached = await getCache(dedupKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(order.totalAmount * 100),
      currency: 'INR',
      receipt: orderId,
    });
    await setCache(dedupKey, razorpayOrder, 600);
    return res.status(200).json(razorpayOrder);
  } catch (err) {
    console.error('[Payment] createOrder Razorpay error:', err.message);
    return res.status(502).json({ message: 'Payment provider error' });
  }
};

// ── confirmPayment ────────────────────────────────────────────────────────────

const confirmPayment = async (req, res) => {
  if (!credentialsValid) {
    return res.status(503).json({ message: 'Payment service unavailable' });
  }

  const { razorpay_order_id, razorpay_payment_id, orderId } = req.body;

  for (const field of ['razorpay_order_id', 'razorpay_payment_id', 'orderId']) {
    if (!req.body[field]) {
      return res.status(400).json({ message: `${field} is required` });
    }
  }

  let payment;
  try {
    payment = await razorpay.payments.fetch(razorpay_payment_id);
  } catch (err) {
    console.error('[Payment] confirmPayment fetch error:', err.message);
    return res.status(502).json({ message: 'Payment provider error' });
  }

  if (!['captured', 'authorized'].includes(payment.status)) {
    return res.status(402).json({ message: 'Payment not completed', status: payment.status });
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { paymentId: razorpay_payment_id },
    { new: true }
  );

  if (!updated) {
    return res.status(404).json({ message: 'Order not found' });
  }

  await publishMessage('payment.verified', {
    razorpay_order_id,
    razorpay_payment_id,
    orderId,
    timestamp: new Date().toISOString(),
  });

  return res.status(200).json({ message: 'Payment confirmed' });
};

// ── verifyPayment ─────────────────────────────────────────────────────────────

const verifyPayment = async (req, res) => {
  try {
    if (!credentialsValid) {
      return res.status(503).json({ message: 'Payment service unavailable' });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    for (const field of ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']) {
      if (!req.body[field]) {
        return res.status(400).json({ message: `${field} is required` });
      }
    }

    // Validate signature is exactly 64 hex characters before timingSafeEqual
    if (!/^[0-9a-fA-F]{64}$/.test(razorpay_signature)) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(razorpay_signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );

    if (isValid) {
      await publishMessage('payment.verified', {
        razorpay_order_id,
        razorpay_payment_id,
        timestamp: new Date().toISOString(),
      });
      return res.status(200).json({ message: 'Payment verified successfully' });
    }

    return res.status(400).json({ message: 'Invalid payment signature' });
  } catch (err) {
    console.error('[Payment] verifyPayment error:', err.message);
    return res.status(400).json({ message: 'Invalid payment signature' });
  }
};

module.exports = { createOrder, confirmPayment, verifyPayment };
