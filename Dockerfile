FROM n8nio/n8n

# Install ffmpeg and other dependencies
USER root
RUN apk add --no-cache \
    ffmpeg \
    curl \
    python3 \
    make \
    g++ \
    && npm install -g node-gyp

# Create directories for temporary files
RUN mkdir -p /tmp/video-processing && chmod 777 /tmp/video-processing

USER node

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5678/health || exit 1