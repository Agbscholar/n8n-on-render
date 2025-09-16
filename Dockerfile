FROM n8nio/n8n:latest

# Switch to root user for package installation
USER root

# Install dependencies for video processing
RUN apk add --no-cache \
    ffmpeg \
    curl \
    python3 \
    make \
    g++ \
    && npm install -g node-gyp n8n \
    && npm config set prefix /home/node/.npm-global \
    && chown -R node:node /home/node/.npm-global

# Create directories with appropriate permissions
RUN mkdir -p /tmp/video-processing && chmod 777 /tmp/video-processing
RUN mkdir -p /home/node/workflows && chown node:node /home/node/workflows
RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node/.n8n

# Copy workflow and package files
COPY business-bot/workflows/supabase-video-processing.js /home/node/workflows/
COPY business-bot/package.json /home/node/

# Install Node.js dependencies
RUN cd /home/node && npm install

# Ensure permissions again before switching user
RUN chown -R node:node /home/node/.n8n /home/node/workflows /home/node/package.json

# Switch back to non-root user for running n8n
USER node

# Set environment variables (will be overridden by Render)
ENV N8N_PORT=5678
ENV PORT=5678
ENV WEBHOOK_URL=https://n8n-on-render-wf30.onrender.com
ENV N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true
ENV PATH=/home/node/.npm-global/bin:$PATH

# Expose port
EXPOSE 5678

# Start n8n
CMD ["n8n", "start"]