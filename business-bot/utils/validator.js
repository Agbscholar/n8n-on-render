const path = require('path');
const logger = require('./logger');

const validator = {
  // Enhanced URL validation with platform-specific checks
  isValidUrl(string) {
    try {
      const url = new URL(string);
      return ['http:', 'https:'].includes(url.protocol);
    } catch (error) {
      return false;
    }
  },

  // Enhanced video URL validation with detailed platform support
  isValidVideoUrl(url) {
    if (!this.isValidUrl(url)) {
      return { valid: false, error: 'Invalid URL format' };
    }

    const supportedPlatforms = [
      { 
        name: 'YouTube', 
        patterns: ['youtube.com', 'youtu.be', 'm.youtube.com'],
        maxLength: 12 * 60 * 60, // 12 hours max
        maxFileSize: 256 * 1024 * 1024 // 256MB
      },
      { 
        name: 'TikTok', 
        patterns: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
        maxLength: 10 * 60, // 10 minutes max
        maxFileSize: 100 * 1024 * 1024 // 100MB
      },
      { 
        name: 'Instagram', 
        patterns: ['instagram.com', 'instagr.am'],
        maxLength: 60 * 60, // 60 minutes max
        maxFileSize: 200 * 1024 * 1024 // 200MB
      },
      { 
        name: 'Twitter', 
        patterns: ['twitter.com', 'x.com', 't.co'],
        maxLength: 2 * 60 + 20, // 2:20 max
        maxFileSize: 512 * 1024 * 1024 // 512MB
      },
      {
        name: 'Facebook',
        patterns: ['facebook.com', 'fb.com', 'fb.watch'],
        maxLength: 4 * 60 * 60, // 4 hours max
        maxFileSize: 300 * 1024 * 1024 // 300MB
      },
      {
        name: 'Vimeo',
        patterns: ['vimeo.com', 'player.vimeo.com'],
        maxLength: 8 * 60 * 60, // 8 hours max
        maxFileSize: 500 * 1024 * 1024 // 500MB
      }
    ];

    const urlLower = url.toLowerCase();
    const platform = supportedPlatforms.find(p => 
      p.patterns.some(pattern => urlLower.includes(pattern))
    );

    if (!platform) {
      return { 
        valid: false, 
        error: `Unsupported platform. Supported platforms: ${supportedPlatforms.map(p => p.name).join(', ')}`
      };
    }

    return { 
      valid: true, 
      platform: platform.name,
      maxLength: platform.maxLength,
      maxFileSize: platform.maxFileSize
    };
  },

  // Enhanced file validation with detailed format support
  isValidFileType(filename, allowedTypes = null) {
    if (!filename || typeof filename !== 'string') return false;
    
    const extension = path.extname(filename).toLowerCase().substring(1);
    
    const defaultAllowedTypes = {
      video: ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', 'flv', '3gp', 'wmv', 'mpg', 'mpeg', 'ogv', 'ts', 'mts'],
      audio: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'wma', 'opus'],
      image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'svg'],
      document: ['pdf', 'doc', 'docx', 'txt', 'rtf'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz']
    };

    if (allowedTypes) {
      return Array.isArray(allowedTypes) 
        ? allowedTypes.includes(extension)
        : defaultAllowedTypes[allowedTypes]?.includes(extension) || false;
    }

    // Check all types if no specific type provided
    return Object.values(defaultAllowedTypes).some(types => types.includes(extension));
  },

  // Enhanced file size validation with subscription-based limits
  isValidFileSize(size, subscriptionType = 'free', fileType = 'video') {
    const limits = {
      free: {
        video: 50 * 1024 * 1024,    // 50MB
        audio: 25 * 1024 * 1024,    // 25MB
        image: 10 * 1024 * 1024,    // 10MB
        document: 5 * 1024 * 1024   // 5MB
      },
      premium: {
        video: 200 * 1024 * 1024,   // 200MB
        audio: 100 * 1024 * 1024,   // 100MB
        image: 25 * 1024 * 1024,    // 25MB
        document: 10 * 1024 * 1024  // 10MB
      },
      pro: {
        video: 1024 * 1024 * 1024,  // 1GB
        audio: 500 * 1024 * 1024,   // 500MB
        image: 100 * 1024 * 1024,   // 100MB
        document: 50 * 1024 * 1024  // 50MB
      }
    };

    const limit = limits[subscriptionType]?.[fileType] || limits.free[fileType] || 50 * 1024 * 1024;
    return size <= limit;
  },

  // Enhanced processing ID validation
  isValidProcessingId(id) {
    if (!id || typeof id !== 'string') return false;
    // Updated pattern to match the new format: proc_timestamp_randomstring
    return /^proc_\d{13}_[a-z0-9]{9}$/.test(id);
  },

  // Enhanced subscription validation
  isValidSubscriptionType(type) {
    return ['free', 'premium', 'pro'].includes(type);
  },

  // Enhanced string sanitization with XSS protection
  sanitizeString(str, maxLength = 255) {
    if (!str || typeof str !== 'string') return '';
    
    return str
      .trim()
      .substring(0, maxLength)
      .replace(/[<>'"&]/g, '') // Remove potential XSS characters
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // Remove control characters
      .replace(/\s+/g, ' '); // Normalize whitespace
  },

  // Enhanced Telegram validation
  isValidTelegramId(id) {
    const numId = parseInt(id);
    return Number.isInteger(numId) && numId > 0 && numId < 10000000000; // Telegram user IDs are up to 10 digits
  },

  isValidChatId(chatId) {
    const numId = parseInt(chatId);
    return Number.isInteger(numId) && numId !== 0 && Math.abs(numId) < 10000000000000; // Chat IDs can be negative
  },

  isValidUsername(username) {
    if (!username) return true; // Username is optional
    return /^[a-zA-Z0-9_]{1,32}$/.test(username) && !username.startsWith('_') && !username.endsWith('_');
  },

  // Enhanced duration validation
  isValidDuration(duration, subscriptionType = 'free') {
    if (!Number.isInteger(duration) || duration <= 0) return false;
    
    const maxDurations = {
      free: 90,      // 1.5 minutes
      premium: 300,  // 5 minutes  
      pro: 600       // 10 minutes
    };
    
    return duration <= (maxDurations[subscriptionType] || maxDurations.free);
  },

  // Enhanced webhook validation
  isValidWebhookSecret(secret) {
    if (!secret || typeof secret !== 'string') return false;
    return secret.length >= 32 && /^[a-f0-9]{32,}$/i.test(secret);
  },

  // MIME type validation
  isValidMimeType(mimeType, expectedType = null) {
    if (!mimeType || typeof mimeType !== 'string') return false;

    const validMimeTypes = {
      video: [
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm',
        'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/x-ms-wmv'
      ],
      audio: [
        'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/mp4',
        'audio/ogg', 'audio/flac', 'audio/x-ms-wma'
      ],
      image: [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'image/bmp', 'image/tiff', 'image/svg+xml'
      ]
    };

    if (expectedType) {
      return validMimeTypes[expectedType]?.includes(mimeType) || false;
    }

    return Object.values(validMimeTypes).some(types => types.includes(mimeType));
  },

  // Enhanced request validation
  validateVideoProcessingRequest(req) {
    const errors = [];
    const warnings = [];

    // Required field validation
    const requiredFields = ['telegram_id', 'chat_id'];
    
    for (const field of requiredFields) {
      if (!req[field]) {
        errors.push(`${field} is required`);
      }
    }

    // Telegram ID validation
    if (req.telegram_id && !this.isValidTelegramId(req.telegram_id)) {
      errors.push('Invalid telegram_id format');
    }

    // Chat ID validation
    if (req.chat_id && !this.isValidChatId(req.chat_id)) {
      errors.push('Invalid chat_id format');
    }

    // Video URL or file validation
    if (!req.video_url && !req.file_path) {
      errors.push('Either video_url or file_path is required');
    }

    if (req.video_url) {
      const urlValidation = this.isValidVideoUrl(req.video_url);
      if (!urlValidation.valid) {
        errors.push(urlValidation.error);
      } else {
        req.platform = urlValidation.platform.toLowerCase();
      }
    }

    // Processing ID validation
    if (req.processing_id && !this.isValidProcessingId(req.processing_id)) {
      errors.push('Invalid processing_id format');
    }

    // Subscription type validation
    if (req.subscription_type && !this.isValidSubscriptionType(req.subscription_type)) {
      errors.push('Invalid subscription_type');
    }

    // File validation if file_path provided
    if (req.file_path) {
      if (req.file_name && !this.isValidFileType(req.file_name, 'video')) {
        warnings.push('File type may not be supported for video processing');
      }

      if (req.file_size && !this.isValidFileSize(req.file_size, req.subscription_type || 'free', 'video')) {
        errors.push('File size exceeds limits for subscription type');
      }

      if (req.mime_type && !this.isValidMimeType(req.mime_type, 'video')) {
        warnings.push('MIME type may not be supported');
      }
    }

    // Sanitize optional string fields
    const stringFields = ['user_name', 'file_name', 'platform'];
    for (const field of stringFields) {
      if (req[field]) {
        req[field] = this.sanitizeString(req[field], field === 'file_name' ? 100 : 50);
      }
    }

    // Duration validation
    if (req.duration && !this.isValidDuration(req.duration, req.subscription_type)) {
      warnings.push('Duration may be too long for subscription type');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitized: req
    };
  },

  // Enhanced file upload validation
  validateFileUpload(file, expectedType = 'video') {
    const errors = [];
    const warnings = [];

    if (!file) {
      errors.push('No file provided');
      return { valid: false, errors };
    }

    // File existence and basic properties
    if (!file.originalname) {
      errors.push('File name is missing');
    }

    if (!file.size || file.size === 0) {
      errors.push('File appears to be empty');
    }

    // File type validation
    if (file.originalname && !this.isValidFileType(file.originalname, expectedType)) {
      const allowedTypes = {
        video: 'mp4, mov, avi, webm, mkv',
        audio: 'mp3, wav, aac, m4a, ogg',
        image: 'jpg, jpeg, png, webp, gif'
      };
      errors.push(`Invalid file type. Allowed: ${allowedTypes[expectedType] || 'video formats'}`);
    }

    // MIME type validation
    if (file.mimetype && !this.isValidMimeType(file.mimetype, expectedType)) {
      warnings.push('MIME type may not match file extension');
    }

    // File path validation
    if (!file.path || typeof file.path !== 'string') {
      errors.push('File path is invalid');
    }

    // Additional video-specific validation
    if (expectedType === 'video') {
      if (file.size > 50 * 1024 * 1024) { // 50MB for free users
        warnings.push('Large file detected - may require premium subscription');
      }

      // Check for suspicious file extensions within filename
      const suspiciousPatterns = ['.exe', '.bat', '.cmd', '.scr', '.vbs', '.js'];
      if (suspiciousPatterns.some(pattern => file.originalname.toLowerCase().includes(pattern))) {
        errors.push('File contains suspicious patterns');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      fileInfo: {
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        path: file.path
      }
    };
  },

  // Rate limit validation
  validateRateLimitParams(windowMs, maxRequests) {
    const errors = [];

    if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > 24 * 60 * 60 * 1000) {
      errors.push('Window must be between 1ms and 24 hours');
    }

    if (!Number.isInteger(maxRequests) || maxRequests <= 0 || maxRequests > 10000) {
      errors.push('Max requests must be between 1 and 10000');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  },

  // Pagination validation
  validatePagination(page, limit) {
    const errors = [];

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 10000) {
      errors.push('Page must be between 1 and 10000');
    }

    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 1000) {
      errors.push('Limit must be between 1 and 1000');
    }

    return {
      valid: errors.length === 0,
      errors,
      page: pageNum,
      limit: limitNum
    };
  },

  // JSON validation with size limits
  isValidJSON(str, maxSizeKB = 100) {
    if (!str || typeof str !== 'string') return false;

    if (str.length > maxSizeKB * 1024) {
      return false; // Too large
    }

    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object';
    } catch (error) {
      return false;
    }
  },

  // Enhanced callback data validation
  validateCallbackData(data) {
    const errors = [];
    const warnings = [];

    // Required fields
    const required = ['processing_id', 'telegram_id', 'chat_id', 'status'];
    for (const field of required) {
      if (!data[field]) {
        errors.push(`${field} is required`);
      }
    }

    // Processing ID
    if (data.processing_id && !this.isValidProcessingId(data.processing_id)) {
      errors.push('Invalid processing_id format');
    }

    // Telegram/Chat IDs
    if (data.telegram_id && !this.isValidTelegramId(data.telegram_id)) {
      errors.push('Invalid telegram_id');
    }

    if (data.chat_id && !this.isValidChatId(data.chat_id)) {
      errors.push('Invalid chat_id');
    }

    // Status validation
    const validStatuses = ['processing', 'completed', 'failed', 'cancelled'];
    if (data.status && !validStatuses.includes(data.status)) {
      errors.push(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    // Results validation for completed status
    if (data.status === 'completed') {
      if (!data.shorts_results) {
        warnings.push('No shorts_results provided for completed status');
      } else {
        try {
          const results = typeof data.shorts_results === 'string' 
            ? JSON.parse(data.shorts_results) 
            : data.shorts_results;

          if (!Array.isArray(results) && typeof results !== 'object') {
            errors.push('shorts_results must be an array or object');
          }
        } catch (parseError) {
          errors.push('shorts_results contains invalid JSON');
        }
      }
    }

    // Error message for failed status
    if (data.status === 'failed' && !data.error_message) {
      warnings.push('No error_message provided for failed status');
    }

    // Processing time validation
    if (data.processing_time !== undefined) {
      const time = parseInt(data.processing_time);
      if (!Number.isInteger(time) || time < 0 || time > 24 * 60 * 60) {
        warnings.push('processing_time should be seconds between 0 and 86400');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  },

  // Security validation helpers
  isSafeFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;

    // Check for directory traversal attempts
    const dangerous = ['../', '..\\', '/..', '\\..'];
    return !dangerous.some(pattern => filePath.includes(pattern));
  },

  isValidStorageBucket(bucketName) {
    if (!bucketName || typeof bucketName !== 'string') return false;

    // Supabase bucket naming rules
    return /^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(bucketName) && 
           bucketName.length >= 3 && 
           bucketName.length <= 63;
  },

  // Content validation
  isValidVideoContent(metadata) {
    const errors = [];
    const warnings = [];

    if (metadata.duration) {
      const duration = parseInt(metadata.duration);
      if (duration < 1) {
        errors.push('Video duration must be at least 1 second');
      }
      if (duration > 12 * 60 * 60) { // 12 hours
        warnings.push('Very long video detected - processing may take extended time');
      }
    }

    if (metadata.width && metadata.height) {
      const width = parseInt(metadata.width);
      const height = parseInt(metadata.height);
      
      if (width < 240 || height < 240) {
        warnings.push('Low resolution video may result in poor quality shorts');
      }
      
      if (width > 7680 || height > 4320) { // 8K resolution
        warnings.push('Very high resolution video - processing may be slow');
      }
    }

    if (metadata.framerate) {
      const fps = parseFloat(metadata.framerate);
      if (fps < 15) {
        warnings.push('Low framerate video may result in choppy shorts');
      }
      if (fps > 120) {
        warnings.push('Very high framerate - file size may be large');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
};

module.exports = validator;