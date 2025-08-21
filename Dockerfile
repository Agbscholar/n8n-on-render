# Use official n8n image
FROM n8nio/n8n:latest

# (Optional) Install ffmpeg if you plan to process audio/video in n8n
USER root
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
USER node

# Copy the start script into the image
COPY --chown=node:node start.sh /start.sh

# Run the script at container start
CMD ["sh", "/start.sh"]
