const path = require('path');

module.exports = {
  validateFileUpload: (file) => {
    const allowedExtensions = ['.mp4', '.mov', '.avi', '.webm'];
    const maxSize = 200 * 1024 * 1024; // 200MB
    const errors = [];

    if (!file.originalname) {
      errors.push('File name is missing');
    } else {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        errors.push(`Invalid file extension: ${ext}. Allowed: ${allowedExtensions.join(', ')}`);
      }
    }

    if (!file.mimetype || !file.mimetype.startsWith('video/')) {
      errors.push(`Invalid MIME type: ${file.mimetype || 'unknown'}`);
    }

    if (file.size > maxSize) {
      errors.push(`File size too large: ${file.size} bytes. Max: ${maxSize} bytes`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
};