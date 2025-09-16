const validator = {
  isValidFileType(filename, allowedTypes = ['mp4', 'mov', 'avi', 'webm']) {
    if (!filename) return false;
    const extension = filename.toLowerCase().split('.').pop();
    return allowedTypes.includes(extension);
  },

  isValidFileSize(size, maxSizeMB = 200) {
    return size <= (maxSizeMB * 1024 * 1024);
  },

  isValidTelegramId(id) {
    return Number.isInteger(id) && id > 0 && id < 2147483647;
  },

  isValidChatId(chatId) {
    return Number.isInteger(chatId) && chatId !== 0;
  },

  isValidProcessingId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^proc_\d+_[a-z0-9]{9}$/.test(id);
  },

  isValidSubscriptionType(type) {
    return ['free', 'premium', 'pro'].includes(type);
  },

  validateFileUpload(file, type = 'video') {
    const errors = [];
    if (!file) {
      errors.push('No file provided');
      return { valid: false, errors };
    }

    const allowedTypes = type === 'video' ? ['mp4', 'mov', 'avi', 'webm'] : ['jpg', 'jpeg', 'png', 'webp'];
    if (!this.isValidFileType(file.originalname, allowedTypes)) {
      errors.push(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`);
    }

    const maxSize = type === 'video' ? 200 : 10;
    if (!this.isValidFileSize(file.size, maxSize)) {
      errors.push(`File too large. Maximum size: ${maxSize}MB`);
    }

    if (!file.path || !file.size) {
      errors.push('File appears to be corrupted or empty');
    }

    return { valid: errors.length === 0, errors, fileInfo: { originalname: file.originalname, size: file.size, mimetype: file.mimetype } };
  },

  validateVideoProcessingRequest(req) {
    const errors = [];

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

    if (!req.processing_id) {
      errors.push('processing_id is required');
    } else if (!this.isValidProcessingId(req.processing_id)) {
      errors.push('Invalid processing_id format');
    }

    if (req.subscription_type && !this.isValidSubscriptionType(req.subscription_type)) {
      errors.push('Invalid subscription_type');
    }

    return { valid: errors.length === 0, errors, sanitized: req };
  }
};

module.exports = validator;