const { getChannel } = require('../config/rabbitmq');
const sendEmail = require('../utils/sendEmail');
const User = require('../models/User');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:statusNotificationWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('order.updated', { durable: true });
  channel.consume('order.updated', async (msg) => {
    if (!msg) return;
    try {
      const { orderId, status, userId } = JSON.parse(msg.content.toString());
      const user = await User.findById(userId).select('email name');
      if (user) {
        const message = `
          <h2>Order Status Update</h2>
          <p>Hello ${user.name},</p>
          <p>Your order <strong>${orderId}</strong> status has been updated to: <strong>${status}</strong></p>
          <p>Thank you for shopping with ShopNest!</p>
        `;
        await sendEmail({ email: user.email, subject: `ShopNest - Order ${status}`, message });
      }
      channel.ack(msg);
    } catch (err) {
      console.error('[Worker:statusNotificationWorker] Error processing message:', err.message);
      channel.nack(msg, false, true);
    }
  }, { noAck: false });

  console.log('[Worker:statusNotificationWorker] Listening on order.updated');
};

module.exports = { start };
