FROM node:20-alpine

# Install postgresql-client for pg_dump (used by the automatic backup system)
RUN apk add --no-cache postgresql-client

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
