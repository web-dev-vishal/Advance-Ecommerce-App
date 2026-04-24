const { getChannel } = require('../config/rabbitmq');
const sendEmail = require('../utils/sendEmail');

const start = async () => {
  const channel = getChannel();
  if (!channel) {
    console.warn('[Worker:welcomeWorker] RabbitMQ unavailable, skipping consumer registration');
    return;
  }

  await channel.assertQueue('user.registered', { durable: true });
  channel.consume('user.registered', async (msg) => {
    if (!msg) return;
    try {
      const { name, email, otp } = JSON.parse(msg.content.toString());
      const message = `
        <h2>Welcome to ShopNest, ${name}!</h2>
        <p>Thank you for registering on our platform.</p>
        <p>Your one-time verification/discount OTP is: <strong>${otp}</strong></p>
      `;
      await sendEmail({ email, subject: 'Welcome to ShopNest - Your OTP', message });
      channel.ack(msg);
    } catch (err) {
      console.error('[Worker:welcomeWorker] Error processing message:', err.message);
      channel.nack(msg, false, true);
    }
  }, { noAck: false });

  console.log('[Worker:welcomeWorker] Listening on user.registered');
};

module.exports = { start };
