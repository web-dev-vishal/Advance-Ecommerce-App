const { getChannel } = require('../config/rabbitmq');
const sendEmail = require('../utils/sendEmail');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:emailWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('order.created', { durable: true });
  channel.consume('order.created', async (msg) => {
    if (!msg) return;
    try {
      const { orderId, email, name, totalAmount, address } = JSON.parse(msg.content.toString());
      const message = `
        <h2>Order Confirmation</h2>
        <p>Hello ${name},</p>
        <p>Your order has been successfully placed! Order ID: <strong>${orderId}</strong></p>
        <p>Total Amount Paid: ${Number(totalAmount).toFixed(2)}</p>
        <p>It will be shipped to: ${address.street}, ${address.city}</p>
        <p>Thank you for shopping with ShopNest!</p>
      `;
      await sendEmail({ email, subject: 'ShopNest - Order Confirmation', message });
      channel.ack(msg);
    } catch (err) {
      console.error('[Worker:emailWorker] Error processing message:', err.message);
      channel.nack(msg, false, true);
    }
  }, { noAck: false });

  console.log('[Worker:emailWorker] Listening on order.created');
};

module.exports = { start };
