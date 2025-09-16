const rateLimit = require('express-rate-limit');

const middleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    timestamp: new Date().toISOString()
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    // Log the blocked request (HTTP only)
    console.warn(`Rate limit exceeded for IP: ${req.ip}`, {
      path: req.path,
      method: req.method,
      userAgent: req.get('User-Agent')
    });
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((Date.now() + 15 * 60 * 1000 - Date.now()) / 1000) // Seconds until reset
    });
  }
});

// Export for Express use only (no Telegram msg handling)
module.exports = {
  middleware,
  expressMiddleware: middleware // For compatibility with index.js
};