const fs = require('fs');
const path = require('path');

class EnhancedLogger {
  constructor() {
    this.logDir = './logs';
    this.maxLogSize = 50 * 1024 * 1024; // 50MB per log file
    this.maxLogFiles = 10;
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.enableConsole = process.env.NODE_ENV !== 'production';
    
    // Log levels (higher number = more verbose)
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      trace: 4
    };

    // Color codes for console output
    this.colors = {
      error: '\x1b[31m',   // Red
      warn: '\x1b[33m',    // Yellow
      info: '\x1b[36m',    // Cyan
      debug: '\x1b[90m',   // Gray
      trace: '\x1b[35m',   // Magenta
      reset: '\x1b[0m'
    };
    
    // Performance tracking
    this.performanceTrackers = new Map();
    
    // Create logs directory
    this.ensureLogDirectory();
    
    // Setup log file streams
    this.setupLogStreams();
    
    // Performance monitoring
    this.startTime = Date.now();
    this.logCounts = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
      trace: 0
    };
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  setupLogStreams() {
    // Create write streams for different log levels
    this.streams = {
      error: fs.createWriteStream(path.join(this.logDir, 'error.log'), { flags: 'a' }),
      combined: fs.createWriteStream(path.join(this.logDir, 'combined.log'), { flags: 'a' }),
      performance: fs.createWriteStream(path.join(this.logDir, 'performance.log'), { flags: 'a' })
    };

    // Handle stream errors
    Object.values(this.streams).forEach(stream => {
      stream.on('error', (error) => {
        console.error('Log stream error:', error.message);
      });
    });
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.logLevel];
  }

  formatMessage(level, message, metadata = {}, context = {}) {
    const timestamp = new Date().toISOString();
    
    // Enhanced metadata with context
    const enrichedMetadata = {
      ...metadata,
      pid: process.pid,
      memory: this.getMemoryUsage(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      ...context
    };

    const logEntry = {
      timestamp,
      level,
      message,
      ...enrichedMetadata
    };

    return JSON.stringify(logEntry) + '\n';
  }

  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
      external: Math.round(usage.external / 1024 / 1024), // MB
      rss: Math.round(usage.rss / 1024 / 1024) // MB
    };
  }

  writeToFile(level, formattedMessage) {
    try {
      // Write to combined log
      this.streams.combined.write(formattedMessage);
      
      // Write errors to separate error log
      if (level === 'error') {
        this.streams.error.write(formattedMessage);
      }
      
      // Check file sizes and rotate if necessary
      this.checkAndRotateLog('combined.log');
      if (level === 'error') {
        this.checkAndRotateLog('error.log');
      }
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  checkAndRotateLog(logFileName) {
    try {
      const logFile = path.join(this.logDir, logFileName);
      
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > this.maxLogSize) {
          this.rotateLogFile(logFile);
        }
      }
    } catch (error) {
      console.error('Error checking log file size:', error.message);
    }
  }

  rotateLogFile(logFile) {
    try {
      const logDir = path.dirname(logFile);
      const logName = path.basename(logFile, '.log');
      
      // Close existing stream
      const streamKey = logName === 'combined' ? 'combined' : 'error';
      if (this.streams[streamKey]) {
        this.streams[streamKey].end();
      }
      
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
      
      // Create new stream
      this.streams[streamKey] = fs.createWriteStream(logFile, { flags: 'a' });
      
      this.info(`Log file rotated: ${logName}.log`);
    } catch (error) {
      console.error('Failed to rotate log file:', error.message);
    }
  }

  log(level, message, metadata = {}, context = {}) {
    if (!this.shouldLog(level)) {
      return;
    }

    // Increment log count
    this.logCounts[level]++;

    const formattedMessage = this.formatMessage(level, message, metadata, context);
    
    // Console output for development
    if (this.enableConsole) {
      const color = this.colors[level] || '';
      const reset = this.colors.reset;
      const metadataStr = Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : '';
      
      console.log(
        `${color}[${level.toUpperCase()}]${reset} ${new Date().toISOString()} ${message}`,
        metadataStr ? `\n${metadataStr}` : ''
      );
    }

    // Write to file
    this.writeToFile(level, formattedMessage);
  }

  // Standard logging methods
  error(message, metadata = {}) {
    this.log('error', message, metadata, { stackTrace: this.getStackTrace() });
  }

  warn(message, metadata = {}) {
    this.log('warn', message, metadata);
  }

  info(message, metadata = {}) {
    this.log('info', message, metadata);
  }

  debug(message, metadata = {}) {
    this.log('debug', message, metadata);
  }

  trace(message, metadata = {}) {
    this.log('trace', message, metadata, { stackTrace: this.getStackTrace() });
  }

  getStackTrace() {
    const stack = new Error().stack;
    return stack ? stack.split('\n').slice(3, 8) : [];
  }

  // Performance timing utilities
  startTimer(label) {
    const startTime = process.hrtime.bigint();
    this.performanceTrackers.set(label, {
      startTime,
      startMemory: process.memoryUsage()
    });
    
    return {
      end: (metadata = {}) => this.endTimer(label, metadata)
    };
  }

  endTimer(label, metadata = {}) {
    const tracker = this.performanceTrackers.get(label);
    if (!tracker) {
      this.warn(`Timer '${label}' was not found`);
      return 0;
    }

    const endTime = process.hrtime.bigint();
    const endMemory = process.memoryUsage();
    const duration = Number(endTime - tracker.startTime) / 1000000; // Convert to milliseconds

    const performanceData = {
      duration_ms: Number(duration.toFixed(3)),
      memory_start: tracker.startMemory.heapUsed,
      memory_end: endMemory.heapUsed,
      memory_delta: endMemory.heapUsed - tracker.startMemory.heapUsed,
      ...metadata
    };

    this.info(`Timer '${label}' completed`, performanceData);
    
    // Write to performance log
    this.writePerformanceLog(label, performanceData);
    
    // Cleanup
    this.performanceTrackers.delete(label);
    
    return duration;
  }

  writePerformanceLog(label, data) {
    try {
      const perfEntry = {
        timestamp: new Date().toISOString(),
        label,
        ...data
      };
      
      this.streams.performance.write(JSON.stringify(perfEntry) + '\n');
    } catch (error) {
      console.error('Failed to write performance log:', error.message);
    }
  }

  // Structured logging for specific events
  logHttpRequest(req, res, responseTime) {
    const metadata = {
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      responseTime: responseTime + 'ms',
      userAgent: req.headers['user-agent'],
      ip: req.ip || req.connection.remoteAddress,
      contentLength: res.get('Content-Length') || 0,
      correlationId: req.correlationId
    };

    if (res.statusCode >= 400) {
      this.warn(`HTTP ${res.statusCode}`, metadata);
    } else {
      this.info(`HTTP ${res.statusCode}`, metadata);
    }
  }

  logTelegramEvent(eventType, userId, chatId, metadata = {}) {
    this.info(`Telegram ${eventType}`, {
      userId,
      chatId,
      ...metadata
    });
  }

  logDatabaseQuery(query, duration, success, metadata = {}) {
    const logData = {
      query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
      duration_ms: duration,
      success,
      ...metadata
    };

    if (success) {
      this.debug('Database query executed', logData);
    } else {
      this.error('Database query failed', logData);
    }
  }

  logFileOperation(operation, fileName, size, success, metadata = {}) {
    const logData = {
      operation,
      fileName,
      size: size ? `${Math.round(size / 1024)}KB` : 'unknown',
      success,
      ...metadata
    };

    if (success) {
      this.info(`File ${operation}`, logData);
    } else {
      this.error(`File ${operation} failed`, logData);
    }
  }

  // System monitoring
  logSystemStats() {
    const stats = {
      memory: this.getMemoryUsage(),
      uptime: Math.floor(process.uptime()),
      cpu: process.cpuUsage(),
      logCounts: { ...this.logCounts }
    };

    this.info('System stats', stats);
  }

  // Error aggregation and analysis
  getErrorSummary(hours = 1) {
    // This would typically read from log files and analyze errors
    // For now, return current session data
    return {
      period: `Last ${hours} hour(s)`,
      errorCount: this.logCounts.error,
      warnCount: this.logCounts.warn,
      totalLogs: Object.values(this.logCounts).reduce((sum, count) => sum + count, 0),
      topErrors: [], // Would be populated by analyzing log files
      timestamp: new Date().toISOString()
    };
  }

  // Health check for logging system
  healthCheck() {
    try {
      // Test log writing
      const testMessage = 'Logger health check';
      this.debug(testMessage);
      
      // Check log directory
      const logDirStats = fs.statSync(this.logDir);
      
      // Check log file sizes
      const logFiles = ['combined.log', 'error.log', 'performance.log'];
      const fileSizes = {};
      
      for (const file of logFiles) {
        const filePath = path.join(this.logDir, file);
        if (fs.existsSync(filePath)) {
          fileSizes[file] = fs.statSync(filePath).size;
        }
      }

      return {
        healthy: true,
        logDirectory: this.logDir,
        logLevel: this.logLevel,
        maxLogSize: this.maxLogSize,
        maxLogFiles: this.maxLogFiles,
        fileSizes,
        logCounts: { ...this.logCounts },
        performanceTrackers: this.performanceTrackers.size,
        uptime: Math.floor((Date.now() - this.startTime) / 1000)
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  // Cleanup old log files
  cleanup(daysOld = 30) {
    try {
      const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      const files = fs.readdirSync(this.logDir);
      let deletedFiles = 0;

      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffTime && file.includes('.')) {
          fs.unlinkSync(filePath);
          deletedFiles++;
        }
      }

      this.info(`Log cleanup completed`, { 
        deletedFiles, 
        daysOld,
        remainingFiles: files.length - deletedFiles 
      });

      return deletedFiles;
    } catch (error) {
      this.error('Log cleanup failed', { error: error.message });
      return 0;
    }
  }

  // Graceful shutdown
  async shutdown() {
    this.info('Logger shutting down...');
    
    // Close all streams
    for (const [name, stream] of Object.entries(this.streams)) {
      try {
        await new Promise((resolve) => {
          stream.end(resolve);
        });
        this.debug(`${name} stream closed`);
      } catch (error) {
        console.error(`Error closing ${name} stream:`, error.message);
      }
    }
    
    console.log('Logger shutdown complete');
  }
}

// Create and export singleton instance
const logger = new EnhancedLogger();

// Setup graceful shutdown
process.on('SIGTERM', () => logger.shutdown());
process.on('SIGINT', () => logger.shutdown());

// Log system stats every 5 minutes in production
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    logger.logSystemStats();
  }, 5 * 60 * 1000);
}

module.exports = logger;