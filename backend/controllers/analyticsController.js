const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { getCache, setCache } = require('../utils/cache');

const getAdminStats = async (req, res) => {
  try {
    const cached = await getCache('analytics:stats');
    if (cached) return res.json(cached);

    const totalOrders = await Order.countDocuments({});
    const totalProducts = await Product.countDocuments({});
    const totalUsers = await User.countDocuments({ role: 'user' });

    const revenueResult = await Order.aggregate([
      { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
    ]);
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;

    const stats = { totalOrders, totalProducts, totalUsers, totalRevenue };
    await setCache('analytics:stats', stats, 60);

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getAdminStats };
