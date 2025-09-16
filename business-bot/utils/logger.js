const logger = {
  info: (message, metadata = {}) => console.log(`INFO: ${message}`, metadata),
  warn: (message, metadata = {}) => console.warn(`WARN: ${message}`, metadata),
  error: (message, metadata = {}) => console.error(`ERROR: ${message}`, metadata)
};
module.exports = logger;