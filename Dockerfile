# ============================================================
# YouTube MP3 Server — Production Dockerfile (Root Context)
# ============================================================
# Compatible with Coolify, Docker Compose, Portainer, and VPS
FROM node:20-bookworm-slim

# Install system dependencies: Linux native ffmpeg, python3, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install official latest Linux yt-dlp binary to /usr/local/bin
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify Linux binaries are installed and accessible on PATH
RUN yt-dlp --version && ffmpeg -version

# Set working directory
WORKDIR /app

# Copy server package files and install production dependencies
COPY server/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy server source code into container
COPY server/ .

# Ensure Windows binaries are not present in Linux container
RUN rm -rf bin/

# Create temporary working directory for conversions and logs
RUN mkdir -p /tmp/ytmp3_temp /app/logs \
    && chmod 777 /tmp/ytmp3_temp

# Set environment
ENV NODE_ENV=production \
    PORT=3500 \
    HOST=0.0.0.0 \
    TEMP_DIR=/tmp/ytmp3_temp

# Expose server port
EXPOSE 3500

# Health check endpoint for Coolify / Docker
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3500/health || exit 1

# Start server
CMD ["node", "server.js"]
