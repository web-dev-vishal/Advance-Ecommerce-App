const Order = require('../models/Order');
const Product = require('../models/Product');
const { getCache, setCache, delCache } = require('../utils/cache');
const { publishMessage } = require('../config/rabbitmq');

const addOrderItems = async (req, res) => {
  try {
    const { items, totalAmount, address, paymentId } = req.body;
    if (items && items.length === 0) {
      return res.status(400).json({ message: 'No order items' });
    }

    const order = new Order({
      userId: req.user._id,
      items,
      totalAmount,
      address,
      paymentId
    });
    const createdOrder = await order.save();

    // Invalidate caches
    await delCache('orders:all', `orders:user:${req.user._id}`, 'analytics:stats');

    // Publish order.created event (email worker handles confirmation email)
    await publishMessage('order.created', {
      orderId: createdOrder._id,
      email: req.user.email,
      name: req.user.name,
      totalAmount,
      address
    });

    // Check stock levels and publish low_stock events
    for (const item of items) {
      try {
        const product = await Product.findById(item.product || item._id || item.productId);
        if (product && product.stock <= 0) {
          await publishMessage('product.low_stock', {
            productId: product._id,
            name: product.name,
            stock: product.stock
          });
        }
      } catch (stockErr) {
        console.warn('[Order] Stock check error:', stockErr.message);
      }
    }

    // Publish analytics invalidation
    await publishMessage('analytics.invalidate', { source: 'order.created' });

    res.status(201).json(createdOrder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMyOrders = async (req, res) => {
  try {
    const cacheKey = `orders:user:${req.user._id}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const orders = await Order.find({ userId: req.user._id });
    await setCache(cacheKey, orders, 120);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const cached = await getCache('orders:all');
    if (cached) return res.json(cached);

    const orders = await Order.find({}).populate('userId', 'id name');
    await setCache('orders:all', orders, 60);
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (order) {
      order.status = req.body.status || order.status;
      const updatedOrder = await order.save();

      // Invalidate caches
      await delCache('orders:all', `orders:user:${order.userId}`);

      // Publish order.updated event (status notification worker handles email)
      await publishMessage('order.updated', {
        orderId: updatedOrder._id,
        status: updatedOrder.status,
        userId: updatedOrder.userId
      });

      // Publish analytics invalidation
      await publishMessage('analytics.invalidate', { source: 'order.updated' });

      res.json(updatedOrder);
    } else {
      res.status(404).json({ message: 'Order not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { addOrderItems, getMyOrders, getOrders, updateOrderStatus };
