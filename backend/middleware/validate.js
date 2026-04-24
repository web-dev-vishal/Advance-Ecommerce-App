const { validationResult } = require('express-validator');

// Runs after express-validator chains — returns 400 if any field fails
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
};

module.exports = validate;
