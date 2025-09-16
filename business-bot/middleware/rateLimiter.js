const rateLimit = require('express-rate-limit');

const middleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP
  message: {
    error: 'Too many requests from this IP, please try again later.',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded for IP: ${req.ip}`, {
      path: req.path,
      method: req.method,
      userAgent: req.get('User-Agent')
    });
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((Date.now() + 15 * 60 * 1000 - Date.now()) / 1000)
    });
  }
});

module.exports = { middleware, expressMiddleware: middleware };