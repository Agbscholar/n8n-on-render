FROM n8nio/n8n

# Install ffmpeg on Alpine
USER root
RUN apk add --no-cache ffmpeg
USER node