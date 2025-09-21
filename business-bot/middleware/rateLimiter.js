const logger = require('../utils/logger');

class EnhancedRateLimiter {
  constructor() {
    this.requests = new Map(); // Store requests by user ID
    this.globalRequests = new Map(); // Store requests by IP for HTTP
    this.blockedUsers = new Map(); // Temporary blocking for abuse
    
    // Rate limiting windows
    this.windowMs = 60 * 1000; // 1 minute window
    this.blockWindowMs = 15 * 60 * 1000; // 15 minute block window
    
    // Request limits per subscription type
    this.maxRequests = {
      free: 15,     // 15 requests per minute for free users
      premium: 50,  // 50 requests per minute for premium users
      pro: 100,     // 100 requests per minute for pro users
      admin: 500    // 500 requests per minute for admin users
    };

    // HTTP rate limits
    this.httpLimits = {
      default: 60,       // 60 requests per minute
      webhook: 200,      // 200 requests per minute for webhooks
      upload: 10,        // 10 uploads per minute
      download: 30       // 30 downloads per minute
    };

    // Abuse detection thresholds
    this.abuseThresholds = {
      rapidFire: 10,     // 10 requests in 10 seconds
      burstLimit: 50,    // 50 requests in burst
      dailyLimit: 1000   // 1000 requests per day per user
    };
    
    // Cleanup intervals
    this.cleanupInterval = 5 * 60 * 1000; // 5 minutes
    this.setupCleanup();
  }

  setupCleanup() {
    // Cleanup old entries every 5 minutes
    setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  cleanup() {
    const now = Date.now();
    let cleanedRequests = 0;
    let cleanedBlocks = 0;
    
    // Clean request tracking
    for (const [key, data] of this.requests.entries()) {
      data.requests = data.requests.filter(timestamp => 
        now - timestamp < this.windowMs
      );
      
      if (data.requests.length === 0) {
        this.requests.delete(key);
        cleanedRequests++;
      }
    }

    // Clean global requests
    for (const [key, data] of this.globalRequests.entries()) {
      data.requests = data.requests.filter(timestamp => 
        now - timestamp < this.windowMs
      );
      
      if (data.requests.length === 0) {
        this.globalRequests.delete(key);
        cleanedRequests++;
      }
    }
    
    // Clean blocked users
    for (const [key, blockTime] of this.blockedUsers.entries()) {
      if (now - blockTime > this.blockWindowMs) {
        this.blockedUsers.delete(key);
        cleanedBlocks++;
      }
    }
    
    if (cleanedRequests > 0 || cleanedBlocks > 0) {
      logger.debug('Rate limiter cleanup completed', { 
        cleanedRequests, 
        cleanedBlocks,
        activeUsers: this.requests.size,
        blockedUsers: this.blockedUsers.size
      });
    }
  }

  // Check if user is temporarily blocked for abuse
  isUserBlocked(userId) {
    const blockTime = this.blockedUsers.get(userId);
    if (blockTime) {
      const timeLeft = this.blockWindowMs - (Date.now() - blockTime);
      if (timeLeft > 0) {
        return { blocked: true, timeLeft };
      } else {
        this.blockedUsers.delete(userId);
      }
    }
    return { blocked: false };
  }

  // Block user temporarily for abuse
  blockUser(userId, reason = 'abuse') {
    this.blockedUsers.set(userId, Date.now());
    logger.warn('User temporarily blocked', { 
      userId, 
      reason, 
      duration: this.blockWindowMs / 1000 / 60 + ' minutes'
    });
  }

  // Detect abusive patterns
  detectAbuse(userId, userData) {
    const now = Date.now();
    const recentRequests = userData.requests.filter(timestamp => 
      now - timestamp < 10000 // Last 10 seconds
    );

    // Rapid fire detection
    if (recentRequests.length >= this.abuseThresholds.rapidFire) {
      this.blockUser(userId, 'rapid_fire');
      return true;
    }

    // Burst detection
    if (userData.requests.length >= this.abuseThresholds.burstLimit) {
      this.blockUser(userId, 'burst_limit');
      return true;
    }

    return false;
  }

  // HTTP rate limiting for Express endpoints
  createHttpRateLimiter(endpoint = 'default', customLimit = null) {
    return (req, res, next) => {
      const identifier = this.getClientIdentifier(req);
      const now = Date.now();
      const key = `http_${identifier}_${endpoint}`;
      
      // Get applicable limit
      const limit = customLimit || this.httpLimits[endpoint] || this.httpLimits.default;
      
      // Get or create request tracking
      let requestData = this.globalRequests.get(key);
      if (!requestData) {
        requestData = { requests: [], endpoint };
        this.globalRequests.set(key, requestData);
      }

      // Filter old requests
      requestData.requests = requestData.requests.filter(timestamp => 
        now - timestamp < this.windowMs
      );

      // Check limit
      if (requestData.requests.length >= limit) {
        const resetTime = Math.min(...requestData.requests) + this.windowMs;
        const resetIn = Math.ceil((resetTime - now) / 1000);

        logger.warn('HTTP rate limit exceeded', {
          ip: identifier,
          endpoint,
          path: req.path,
          method: req.method,
          limit,
          resetIn
        });

        res.set({
          'X-RateLimit-Limit': limit,
          'X-RateLimit-Remaining': 0,
          'X-RateLimit-Reset': Math.floor(resetTime / 1000),
          'Retry-After': resetIn
        });

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for ${endpoint}. Try again in ${resetIn} seconds.`,
          limit,
          remaining: 0,
          resetTime: Math.floor(resetTime / 1000)
        });
      }

      // Add current request
      requestData.requests.push(now);

      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': limit,
        'X-RateLimit-Remaining': limit - requestData.requests.length,
        'X-RateLimit-Reset': Math.floor((now + this.windowMs) / 1000)
      });

      next();
    };
  }

  // Get client identifier for HTTP requests
  getClientIdentifier(req) {
    // Try to get real IP through various headers
    return req.headers['cf-connecting-ip'] || // Cloudflare
           req.headers['x-real-ip'] ||         // Nginx
           req.headers['x-forwarded-for']?.split(',')[0] || // Load balancer
           req.connection.remoteAddress ||     // Direct connection
           req.ip ||                           // Express default
           'unknown';
  }

  // Telegram middleware factory
  createTelegramMiddleware() {
    return async (msg, metadata) => {
      const userId = msg.from.id;
      const chatId = msg.chat.id;
      
      try {
        // Determine context from message type
        let context = 'general';
        if (msg.document || msg.video || msg.audio) {
          context = 'file_upload';
        } else if (msg.text && (msg.text.includes('http') || msg.text.includes('www'))) {
          context = 'url_processing';
        } else if (msg.text && msg.text.startsWith('/')) {
          context = 'command';
        }

        // Get user subscription type from database
        const db = require('../utils/supabase');
        const user = await db.getUser(userId);
        const subscriptionType = user?.subscription_type || 'free';

        const limitInfo = this.isRateLimited(userId, subscriptionType, context);

        if (limitInfo.limited) {
          const bot = require('../index').bot;
          
          let message = limitInfo.message;
          
          // Add upgrade suggestion for free users
          if (subscriptionType === 'free' && limitInfo.reason === 'rate_limit') {
            message += '\n\n💎 Upgrade to Premium for higher limits!\nContact @Osezblessed to upgrade.';
          }

          // Add specific guidance based on reason
          if (limitInfo.reason === 'temporarily_blocked') {
            message += '\n\n🛡️ This is to protect our service from abuse.\nPlease use the bot responsibly.';
          }

          await bot.sendMessage(chatId, message);
          
          logger.warn('Telegram rate limit applied', {
            userId,
            subscriptionType,
            context,
            reason: limitInfo.reason,
            limit: limitInfo.limit
          });
          
          return false; // Block the request
        }

        logger.debug('Telegram rate limit check passed', {
          userId,
          subscriptionType,
          context,
          remaining: limitInfo.remaining
        });

        return true; // Allow the request
      } catch (error) {
        logger.error('Rate limiter error', { 
          userId, 
          error: error.message 
        });
        return true; // Allow request on error to avoid blocking users
      }
    };
  }

  // Manual administration methods
  clearUserLimits(userId) {
    const userKey = `user_${userId}`;
    const cleared = this.requests.delete(userKey);
    
    if (cleared) {
      logger.info('Rate limits cleared for user', { userId });
    }
    
    return cleared;
  }

  unblockUser(userId) {
    const wasBlocked = this.blockedUsers.delete(userId);
    
    if (wasBlocked) {
      logger.info('User unblocked manually', { userId });
    }
    
    return wasBlocked;
  }

  // Emergency rate limit adjustment
  adjustLimits(subscriptionType, newLimit) {
    if (!this.maxRequests.hasOwnProperty(subscriptionType)) {
      throw new Error(`Invalid subscription type: ${subscriptionType}`);
    }

    const oldLimit = this.maxRequests[subscriptionType];
    this.maxRequests[subscriptionType] = newLimit;

    logger.info('Rate limits adjusted', {
      subscriptionType,
      oldLimit,
      newLimit
    });

    return { subscriptionType, oldLimit, newLimit };
  }

  // Get comprehensive statistics
  getStats() {
    const now = Date.now();
    
    const stats = {
      totalUsers: this.requests.size,
      totalHttpClients: this.globalRequests.size,
      blockedUsers: this.blockedUsers.size,
      breakdown: {
        free: 0,
        premium: 0,
        pro: 0,
        admin: 0,
        http: this.globalRequests.size
      },
      activity: {
        last_minute: 0,
        last_5_minutes: 0,
        last_hour: 0
      },
      contexts: {
        general: 0,
        file_upload: 0,
        url_processing: 0,
        command: 0
      }
    };

    // Analyze user breakdown and activity
    for (const [key, data] of this.requests.entries()) {
      if (data.subscriptionType) {
        stats.breakdown[data.subscriptionType]++;
      }

      // Count recent activity
      const recentRequests = data.requests.filter(timestamp => {
        const age = now - timestamp;
        if (age < 60000) stats.activity.last_minute++;
        if (age < 300000) stats.activity.last_5_minutes++;
        if (age < 3600000) stats.activity.last_hour++;
        return age < this.windowMs;
      });

      // Count context usage
      if (data.context) {
        for (const [context, requests] of data.context.entries()) {
          const activeRequests = requests.filter(timestamp => 
            now - timestamp < this.windowMs
          ).length;
          stats.contexts[context] = (stats.contexts[context] || 0) + activeRequests;
        }
      }
    }

    // Add configuration info
    stats.config = {
      windowMs: this.windowMs,
      limits: this.maxRequests,
      httpLimits: this.httpLimits,
      abuseThresholds: this.abuseThresholds
    };

    return stats;
  }

  // Health check
  healthCheck() {
    const stats = this.getStats();
    const memoryUsage = process.memoryUsage();
    
    return {
      healthy: true,
      activeUsers: stats.totalUsers,
      blockedUsers: stats.blockedUsers,
      memoryUsage: {
        requests_mb: (JSON.stringify([...this.requests]).length / 1024 / 1024).toFixed(2),
        total_mb: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2)
      },
      performance: {
        cleanup_interval: this.cleanupInterval,
        last_cleanup: this.lastCleanup || 'never'
      }
    };
  }
}

// Create singleton instance
const rateLimiterInstance = new EnhancedRateLimiter();

// Export structured module
module.exports = {
  // Default telegram middleware
  middleware: rateLimiterInstance.createTelegramMiddleware(),
  
  // Instance for direct access
  instance: rateLimiterInstance,
  
  // Express middlewares
  expressMiddleware: rateLimiterInstance.createHttpRateLimiter('default'),
  uploadMiddleware: rateLimiterInstance.createHttpRateLimiter('upload'),
  webhookMiddleware: rateLimiterInstance.createHttpRateLimiter('webhook'),
  downloadMiddleware: rateLimiterInstance.createHttpRateLimiter('download'),
  
  // Custom middleware creator
  customMiddleware: (endpoint, limit) => rateLimiterInstance.createHttpRateLimiter(endpoint, limit),
  
  // Admin functions
  clearUser: (userId) => rateLimiterInstance.clearUserLimits(userId),
  unblockUser: (userId) => rateLimiterInstance.unblockUser(userId),
  adjustLimits: (type, limit) => rateLimiterInstance.adjustLimits(type, limit),
  getStats: () => rateLimiterInstance.getStats(),
  healthCheck: () => rateLimiterInstance.healthCheck()
};