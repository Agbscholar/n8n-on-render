const validator = {
  // URL validation
  isValidUrl(string) {
    try {
      const url = new URL(string);
      return ['http:', 'https:'].includes(url.protocol);
    } catch (error) {
      return false;
    }
  },

  // Video URL validation with platform support check
  isValidVideoUrl(url) {
    if (!this.isValidUrl(url)) {
      return { valid: false, error: 'Invalid URL format' };
    }

    const supportedPlatforms = [
      { name: 'YouTube', patterns: ['youtube.com', 'youtu.be'], maxLength: 11 * 60 * 60 }, // 11 hours max
      { name: 'TikTok', patterns: ['tiktok.com', 'vm.tiktok.com'], maxLength: 10 * 60 }, // 10 minutes max
      { name: 'Instagram', patterns: ['instagram.com'], maxLength: 60 * 60 }, // 60 minutes max
      { name: 'Twitter', patterns: ['twitter.com', 'x.com'], maxLength: 2 * 60 + 20 } // 2:20 max
    ];

    const urlLower = url.toLowerCase();
    const platform = supportedPlatforms.find(p => 
      p.patterns.some(pattern => urlLower.includes(pattern))
    );

    if (!platform) {
      return { 
        valid: false, 
        error: 'Unsupported platform. Only YouTube, TikTok, Instagram, and Twitter/X are supported.' 
      };
    }

    return { 
      valid: true, 
      platform: platform.name,
      maxLength: platform.maxLength
    };
  },

  // Telegram ID validation
  isValidTelegramId(id) {
    return Number.isInteger(id) && id > 0 && id < 2147483647;
  },

  // File validation
  isValidFileType(filename, allowedTypes = ['mp4', 'mov', 'avi', 'webm', 'jpg', 'jpeg', 'png']) {
    if (!filename) return false;
    
    const extension = filename.toLowerCase().split('.').pop();
    return allowedTypes.includes(extension);
  },

  isValidFileSize(size, maxSizeMB = 200) {
    return size <= (maxSizeMB * 1024 * 1024);
  },

  // Processing ID validation
  isValidProcessingId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^proc_\d+_[a-z0-9]{9}$/.test(id);
  },

  // Subscription type validation
  isValidSubscriptionType(type) {
    return ['free', 'premium', 'pro'].includes(type);
  },

  // String sanitization
  sanitizeString(str, maxLength = 255) {
    if (!str || typeof str !== 'string') return '';
    
    return str
      .trim()
      .substring(0, maxLength)
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/[\x00-\x1f\x7f]/g, ''); // Remove control characters
  },

  // Username validation
  isValidUsername(username) {
    if (!username) return true; // Username is optional
    return /^[a-zA-Z0-9_]{1,32}$/.test(username);
  },

  // Chat ID validation
  isValidChatId(chatId) {
    return Number.isInteger(chatId) && chatId !== 0;
  },

  // Duration validation (in seconds)
  isValidDuration(duration, minSeconds = 1, maxSeconds = 90 * 60) {
    return Number.isInteger(duration) && duration >= minSeconds && duration <= maxSeconds;
  },

  // Webhook secret validation
  isValidWebhookSecret(secret) {
    if (!secret || typeof secret !== 'string') return false;
    return secret.length >= 32 && /^[a-f0-9]{32,}$/.test(secret);
  },

  // Rate limiting validation
  validateRateLimitParams(windowMs, maxRequests) {
    return (
      Number.isInteger(windowMs) && windowMs > 0 && windowMs <= 24 * 60 * 60 * 1000 && // Max 24 hours
      Number.isInteger(maxRequests) && maxRequests > 0 && maxRequests <= 1000 // Max 1000 requests
    );
  },

  // Pagination validation
  validatePagination(page, limit) {
    const validPage = Number.isInteger(page) && page >= 1 && page <= 1000;
    const validLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100;
    return { validPage, validLimit };
  },

  // JSON validation
  isValidJSON(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (error) {
      return false;
    }
  },

  // Comprehensive request validation
  validateVideoProcessingRequest(req) {
    const errors = [];

    // Check required fields
    if (!req.telegram_id) {
      errors.push('telegram_id is required');
    } else if (!this.isValidTelegramId(req.telegram_id)) {
      errors.push('Invalid telegram_id format');
    }

    if (!req.chat_id) {
      errors.push('chat_id is required');
    } else if (!this.isValidChatId(req.chat_id)) {
      errors.push('Invalid chat_id format');
    }

    if (!req.video_url) {
      errors.push('video_url is required');
    } else {
      const urlValidation = this.isValidVideoUrl(req.video_url);
      if (!urlValidation.valid) {
        errors.push(urlValidation.error);
      }
    }

    if (!req.processing_id) {
      errors.push('processing_id is required');
    } else if (!this.isValidProcessingId(req.processing_id)) {
      errors.push('Invalid processing_id format');
    }

    if (req.subscription_type && !this.isValidSubscriptionType(req.subscription_type)) {
      errors.push('Invalid subscription_type');
    }

    // Sanitize optional string fields
    if (req.user_name) {
      req.user_name = this.sanitizeString(req.user_name, 100);
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: req
    };
  },

  // File upload validation
  validateFileUpload(file, type = 'video') {
    const errors = [];

    if (!file) {
      errors.push('No file provided');
      return { valid: false, errors };
    }

    // Check file type
    const allowedTypes = type === 'video' 
      ? ['mp4', 'mov', 'avi', 'webm', 'mkv']
      : ['jpg', 'jpeg', 'png', 'webp'];

    if (!this.isValidFileType(file.originalname, allowedTypes)) {
      errors.push(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`);
    }

    // Check file size
    const maxSize = type === 'video' ? 200 : 10; // 200MB for videos, 10MB for images
    if (!this.isValidFileSize(file.size, maxSize)) {
      errors.push(`File too large. Maximum size: ${maxSize}MB`);
    }

    // Check if file exists and is readable
    if (!file.path || !file.size) {
      errors.push('File appears to be corrupted or empty');
    }

    return {
      valid: errors.length === 0,
      errors,
      fileInfo: {
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype
      }
    };
  }
};

module.exports = validator;