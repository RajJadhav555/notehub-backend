# ================================
# NoteHub Backend Dockerfile
# ================================
FROM node:22-alpine

# Install curl (needed for healthcheck) and other tools
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files first (layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy all source files
COPY . .

# Create uploads directory
RUN mkdir -p uploads

EXPOSE 7860

# Use node directly (not nodemon) in production
CMD ["node", "src/server.js"]
