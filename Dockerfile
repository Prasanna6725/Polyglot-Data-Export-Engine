# Multi-stage build
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:18-alpine

WORKDIR /app

# Install dumb-init and bash for proper signal handling and entrypoint
RUN apk add --no-cache dumb-init bash

# sanity check: ensure passwd file hasn't been corrupted by earlier layers
RUN [ -s /etc/passwd ] || echo "root:x:0:0:root:/root:/bin/sh" > /etc/passwd
RUN grep -q '^root:' /etc/passwd

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY . .

# Copy entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Create non-root user (ensure passwd file still intact afterwards)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
RUN grep -q '^nodejs:' /etc/passwd || (echo "nodejs:x:1001:1001::/app:/sbin/nologin" >> /etc/passwd)

# Install PostgreSQL client tools for wait script
RUN apk add --no-cache postgresql-client

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init (from PATH) to handle signals properly and run the entrypoint with bash
ENTRYPOINT ["dumb-init", "--"]
CMD ["/bin/bash", "/app/docker-entrypoint.sh"]
