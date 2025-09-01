const logger = require('../utils/logger');

class RateLimiter {
  constructor() {
    this.requests = new Map();
    this.windowMs = 60 * 1000; // 1 minute window
    this.maxRequests = {
      free: 10,
      premium: 30,
      pro: 60
    };
    
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, data] of this.requests.entries()) {
      data.requests = data.requests.filter(timestamp => 
        now - timestamp < this.windowMs
      );
      
      if (data.requests.length === 0) {
        this.requests.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Rate limiter cleanup: removed ${cleaned} expired entries`);
    }
  }

  isRateLimited(userId, subscriptionType = 'free') {
    const now = Date.now();
    const key = `user_${userId}`;
    
    let userData = this.requests.get(key);
    if (!userData) {
      userData = { requests: [], subscriptionType };
      this.requests.set(key, userData);
    }

    userData.subscriptionType = subscriptionType;
    userData.requests = userData.requests.filter(timestamp => 
      now - timestamp < this.windowMs
    );

    const limit = this.maxRequests[subscriptionType] || this.maxRequests.free;
    
    if (userData.requests.length >= limit) {
      return {
        limited: true,
        limit,
        remaining: 0,
        resetTime: Math.min(...userData.requests) + this.windowMs
      };
    }

    userData.requests.push(now);

    return {
      limited: false,
      limit,
      remaining: limit - userData.requests.length,
      resetTime: now + this.windowMs
    };
  }

  // Telegram middleware that accepts bot instance as parameter
  async checkTelegramRateLimit(msg, bot, getUser) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    try {
      // Get user subscription type
      const user = await getUser(userId);
      const subscriptionType = user?.subscription_type || 'free';

      const limitInfo = this.isRateLimited(userId, subscriptionType);

      if (limitInfo.limited) {
        const resetIn = Math.ceil((limitInfo.resetTime - Date.now()) / 1000);
        
        const limitMessage = `Too many requests! You've exceeded your rate limit of ${limitInfo.limit} requests per minute. Please wait ${resetIn} seconds before trying again.`;

        await bot.sendMessage(chatId, limitMessage);
        
        logger.warn('Rate limit exceeded', {
          userId,
          subscriptionType,
          limit: limitInfo.limit,
          resetIn
        });
        
        return false;
      }

      logger.debug('Rate limit check passed', {
        userId,
        subscriptionType,
        remaining: limitInfo.remaining
      });

      return true;
    } catch (error) {
      logger.error('Rate limiter error', { 
        userId, 
        error: error.message 
      });
      return true; // Allow request on error
    }
  }

  createExpressMiddleware(customLimits = {}) {
    return (req, res, next) => {
      const identifier = req.ip || req.connection.remoteAddress;
      const key = `http_${identifier}`;
      
      const limits = {
        windowMs: customLimits.windowMs || this.windowMs,
        maxRequests: customLimits.maxRequests || 100
      };

      const now = Date.now();
      let userData = this.requests.get(key);
      
      if (!userData) {
        userData = { requests: [] };
        this.requests.set(key, userData);
      }

      userData.requests = userData.requests.filter(timestamp => 
        now - timestamp < limits.windowMs
      );

      if (userData.requests.length >= limits.maxRequests) {
        const resetTime = Math.min(...userData.requests) + limits.windowMs;
        const resetIn = Math.ceil((resetTime - now) / 1000);

        logger.warn('HTTP rate limit exceeded', {
          ip: identifier,
          path: req.path,
          method: req.method,
          limit: limits.maxRequests,
          resetIn
        });

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${resetIn} seconds.`,
          limit: limits.maxRequests,
          remaining: 0,
          resetTime: Math.floor(resetTime / 1000)
        });
      }

      userData.requests.push(now);

      res.set({
        'X-RateLimit-Limit': limits.maxRequests,
        'X-RateLimit-Remaining': limits.maxRequests - userData.requests.length,
        'X-RateLimit-Reset': Math.floor((now + limits.windowMs) / 1000)
      });

      next();
    };
  }

  getStats() {
    const stats = {
      totalUsers: this.requests.size,
      breakdown: {
        free: 0,
        premium: 0,
        pro: 0,
        http: 0
      }
    };

    for (const [key, data] of this.requests.entries()) {
      if (key.startsWith('http_')) {
        stats.breakdown.http++;
      } else {
        const type = data.subscriptionType || 'free';
        stats.breakdown[type]++;
      }
    }

    return stats;
  }

  clearUserLimits(userId) {
    const key = `user_${userId}`;
    const cleared = this.requests.delete(key);
    
    if (cleared) {
      logger.info('Rate limits cleared for user', { userId });
    }
    
    return cleared;
  }
}

module.exports = new RateLimiter();