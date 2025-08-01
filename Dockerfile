FROM node:22-alpine

# Install GDAL and required dependencies
RUN apk add --no-cache \
    gdal \
    gdal-tools \
    gdal-dev \
    proj \
    proj-dev \
    geos \
    geos-dev

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile

# Copy application code
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["pnpm", "start"]
