const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = './logs';
    this.maxLogSize = 10 * 1024 * 1024; // 10MB
    this.maxLogFiles = 5;
    
    // Create logs directory
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  formatMessage(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...metadata
    };

    return JSON.stringify(logEntry) + '\n';
  }

  writeToFile(level, formattedMessage) {
    try {
      const logFile = path.join(this.logDir, `${level}.log`);
      
      // Check file size and rotate if necessary
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > this.maxLogSize) {
          this.rotateLogFile(logFile);
        }
      }

      fs.appendFileSync(logFile, formattedMessage);
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  rotateLogFile(logFile) {
    try {
      const logDir = path.dirname(logFile);
      const logName = path.basename(logFile, '.log');
      
      // Rotate existing files
      for (let i = this.maxLogFiles - 1; i > 0; i--) {
        const oldFile = path.join(logDir, `${logName}.${i}.log`);
        const newFile = path.join(logDir, `${logName}.${i + 1}.log`);
        
        if (fs.existsSync(oldFile)) {
          if (i === this.maxLogFiles - 1) {
            fs.unlinkSync(oldFile); // Delete oldest
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }
      
      // Rotate current file
      const rotatedFile = path.join(logDir, `${logName}.1.log`);
      fs.renameSync(logFile, rotatedFile);
    } catch (error) {
      console.error('Failed to rotate log file:', error.message);
    }
  }

  log(level, message, metadata = {}) {
    const formattedMessage = this.formatMessage(level, message, metadata);
    
    // Always log to console in development
    if (process.env.NODE_ENV !== 'production') {
      const colors = {
        error: '\x1b[31m',
        warn: '\x1b[33m',
        info: '\x1b[36m',
        debug: '\x1b[90m'
      };
      
      const reset = '\x1b[0m';
      const color = colors[level] || '';
      
      console.log(`${color}[${level.toUpperCase()}]${reset} ${message}`, 
        Object.keys(metadata).length > 0 ? metadata : '');
    }

    // Write to file
    this.writeToFile(level, formattedMessage);
    
    // Also write errors and warnings to general log
    if (level === 'error' || level === 'warn') {
      this.writeToFile('general', formattedMessage);
    }
  }

  info(message, metadata = {}) {
    this.log('info', message, metadata);
  }

  warn(message, metadata = {}) {
    this.log('warn', message, metadata);
  }

  error(message, metadata = {}) {
    this.log('error', message, metadata);
  }

  debug(message, metadata = {}) {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
      this.log('debug', message, metadata);
    }
  }

  // Performance timing helper
  time(label) {
    const startTime = process.hrtime.bigint();
    return {
      end: (metadata = {}) => {
        const endTime = process.hrtime.bigint();
        const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
        this.info(`${label} completed`, { duration_ms: duration, ...metadata });
        return duration;
      }
    };
  }
}

module.exports = new Logger();