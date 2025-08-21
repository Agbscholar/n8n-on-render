#!/bin/sh
set -e

# Render assigns the port number to $PORT at runtime.
# n8n listens on N8N_PORT, so map it.
export N8N_PORT="${PORT:-5678}"

# If you already know your public URL, you can set WEBHOOK_URL in the dashboard later.
# export WEBHOOK_URL="https://your-service.onrender.com"

# Start n8n
exec n8n
