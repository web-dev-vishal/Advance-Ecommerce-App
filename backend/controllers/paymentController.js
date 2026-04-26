const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getCache, setCache } = require('../utils/cache');
const { publishMessage } = require('../config/rabbitmq');

const createOrder = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Valid amount is required' });
    }

    const amountInPaise = Math.round(amount * 100);
    const userId = req.user._id;
    const dedupKey = `payment:dedup:${userId}:${amountInPaise}`;

    // Return cached Razorpay order if same user+amount within 10 min
    const cached = await getCache(dedupKey);
    if (cached) return res.json(cached);

    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await instance.orders.create({ amount: amountInPaise, currency: 'INR' });
    if (!order) return res.status(500).json({ message: 'Failed to create Razorpay order' });

    await setCache(dedupKey, order, 600);
    res.json(order);
  } catch (error) {
    console.error('[Payment] createOrder error:', error.message);
    res.status(500).json({ message: 'Payment order creation failed' });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
    }

    // Razorpay signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret)
    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(payload)
      .digest('hex');

    // Compare hex strings directly using constant-time comparison
    // Both are always the same length (64-char hex), so timingSafeEqual never throws
    const sigBuffer = Buffer.from(razorpay_signature, 'utf8');
    const expBuffer = Buffer.from(expectedSign, 'utf8');

    const isValid =
      sigBuffer.length === expBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, expBuffer);

    if (isValid) {
      await publishMessage('payment.verified', {
        razorpay_order_id,
        razorpay_payment_id,
        timestamp: new Date().toISOString(),
      });
      return res.status(200).json({ message: 'Payment verified successfully' });
    }

    return res.status(400).json({ message: 'Invalid payment signature' });
  } catch (error) {
    console.error('[Payment] verifyPayment error:', error.message);
    res.status(500).json({ message: 'Payment verification failed' });
  }
};

module.exports = { createOrder, verifyPayment };
