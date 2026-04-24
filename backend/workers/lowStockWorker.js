const { getChannel } = require('../config/rabbitmq');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:lowStockWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('product.low_stock', { durable: true });
  channel.consume('product.low_stock', async (msg) => {
    if (!msg) return;
    try {
      const { productId, name, stock } = JSON.parse(msg.content.toString());
      console.warn('[LowStock]', { productId, name, stock });
      channel.ack(msg);
    } catch (err) {
      console.error('[Worker:lowStockWorker] Error processing message:', err.message);
      channel.ack(msg);
    }
  }, { noAck: false });

  console.log('[Worker:lowStockWorker] Listening on product.low_stock');
};

module.exports = { start };
