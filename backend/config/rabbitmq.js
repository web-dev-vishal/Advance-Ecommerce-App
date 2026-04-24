const amqplib = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';

let connection = null;
let channel = null;

const connectRabbitMQ = async () => {
  try {
    connection = await amqplib.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    console.log('[RabbitMQ] Connected successfully');
  } catch (err) {
    console.warn('[RabbitMQ] Connection failed:', err.message);
    connection = null;
    channel = null;
  }
};

const getChannel = () => channel;

const publishMessage = async (queue, payload) => {
  if (!channel) {
    console.warn(`[RabbitMQ] Channel unavailable, skipping publish to ${queue}`);
    return;
  }
  try {
    await channel.assertQueue(queue, { durable: true });
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
  } catch (err) {
    console.warn(`[RabbitMQ] Failed to publish to ${queue}:`, err.message);
  }
};

module.exports = { connectRabbitMQ, getChannel, publishMessage };
