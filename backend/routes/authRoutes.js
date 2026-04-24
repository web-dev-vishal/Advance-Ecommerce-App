const express = require('express');
const { registerUser, loginUser, getUsers } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const rateLimiter = require('../middleware/rateLimiter');
const router = express.Router();

router.post('/register', rateLimiter, registerUser);
router.post('/login', rateLimiter, loginUser);
router.get('/users', protect, admin, getUsers);

module.exports = router;
