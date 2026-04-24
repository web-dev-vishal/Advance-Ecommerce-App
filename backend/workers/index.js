const emailWorker = require('./emailWorker');
const welcomeWorker = require('./welcomeWorker');
const statusNotificationWorker = require('./statusNotificationWorker');
const lowStockWorker = require('./lowStockWorker');
const paymentAuditWorker = require('./paymentAuditWorker');
const analyticsInvalidationWorker = require('./analyticsInvalidationWorker');

const startWorkers = () => {
  emailWorker.start();
  welcomeWorker.start();
  statusNotificationWorker.start();
  lowStockWorker.start();
  paymentAuditWorker.start();
  analyticsInvalidationWorker.start();
};

module.exports = startWorkers;
