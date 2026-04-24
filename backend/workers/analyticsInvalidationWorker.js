const { getChannel } = require('../config/rabbitmq');
const { delCache } = require('../utils/cache');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:analyticsInvalidationWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('analytics.invalidate', { durable: true });
  channel.consume('analytics.invalidate', async (msg) => {
    if (!msg) return;
    try {
      await delCache('analytics:stats');
      channel.ack(msg);
    } catch (err) {
      console.warn('[Worker:analyticsInvalidationWorker] Error:', err.message);
      channel.ack(msg);
    }
  }, { noAck: false });

  console.log('[Worker:analyticsInvalidationWorker] Listening on analytics.invalidate');
};

module.exports = { start };
