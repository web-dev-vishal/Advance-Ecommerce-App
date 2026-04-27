const { getChannel } = require('../config/rabbitmq');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:paymentAuditWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('payment.verified', { durable: true });
  channel.consume('payment.verified', async (msg) => {
    if (!msg) return;
    try {
      const { razorpay_order_id, razorpay_payment_id, orderId, timestamp } = JSON.parse(msg.content.toString());
      console.log('[PaymentAudit]', { orderId, razorpay_order_id, razorpay_payment_id, timestamp });
      channel.ack(msg);
    } catch (err) {
      console.error('[Worker:paymentAuditWorker] Error processing message:', err.message);
      channel.ack(msg);
    }
  }, { noAck: false });

  console.log('[Worker:paymentAuditWorker] Listening on payment.verified');
};

module.exports = { start };
