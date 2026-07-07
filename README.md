# FOMbot - Multilingual Faculty Bot Manager

A production-ready, cloud-native, horizontally scalable platform to manage multiple Telegram bots for faculties or organizations.

## Key Features
- **Stateless Architecture**: Safely run multiple replicas without sticky sessions.
- **S3-Compatible Storage**: Uploads and downloads stream directly to/from S3 (Cloudflare R2, AWS S3, MinIO) without buffering in memory or on disk.
- **PostgreSQL Data & State**: All data and intermediate admin flow state is stored in a transactional Postgres database.
- **Optional Redis Caching**: Dramatically speeds up menu and config retrieval while falling back cleanly to Postgres if unavailable.
- **Structured Logging (Pino)**: High performance JSON logging with Request ID correlation and sensitive data redaction.
- **Production Probes**: Built-in `/health` and `/ready` endpoints for Kubernetes/Docker/Render deployments.
- **Telegram File ID Caching**: Saves immense bandwidth by caching and reusing Telegram `file_id`s, while seamlessly falling back to S3 streaming if a file is purged by Telegram.
- **Robust Rate Limiting**: Distributed rate-limiting via Redis (with memory fallback) protects public APIs while guaranteeing legitimate webhook traffic is never blocked.
- **Broadcast Reliability**: Incorporates exponential backoff to handle transient Telegram API errors without dropping announcements.
- **Automated S3 Backups**: (Optional) Scheduled, automated backups of your PostgreSQL database pushed directly to S3 with configurable retention policies.

## Configuration & Environment Variables

All configuration is done via environment variables.

### Core & Database
- `PORT`: Port the HTTP server runs on (Default: `3000`)
- `NODE_ENV`: Set to `production` in live environments (disables pretty-logging, enforces SSL DB checks).
- `DATABASE_URL`: PostgreSQL connection string (e.g., `postgresql://user:pass@host:5432/db`)

### Object Storage (S3 / R2 / MinIO)
- `S3_ENDPOINT`: The S3 API endpoint (e.g., `https://<account_id>.r2.cloudflarestorage.com` or `http://localhost:9000`)
- `S3_REGION`: Region (e.g., `auto` for R2, `us-east-1` for AWS)
- `S3_BUCKET`: Name of the bucket (e.g., `fombot-uploads`)
- `S3_ACCESS_KEY`: Access Key ID
- `S3_SECRET_KEY`: Secret Access Key

### Webhooks
- `WEBHOOK_URL`: Your public domain (e.g., `https://fombot.example.com`). Telegram will send updates to this address.
- `WEBHOOK_SECRET`: A secret string used to securely authenticate incoming webhooks from Telegram.

### Logging (Pino)
- `LOG_LEVEL`: Configures the structured logger. Valid values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. (Default: `info`)

### Redis Caching & Rate Limiting (Optional)
- `REDIS_URL`: Redis connection string (e.g., `redis://user:pass@host:6379`). **If omitted or unreachable, the application falls back to querying PostgreSQL and using in-memory rate limiting.**
- `CACHE_TTL_SECONDS`: How long to cache frequently accessed items like menus and faculty configs. (Default: `300`)

### Automated Backups (Optional)
- `BACKUP_ENABLED`: Set to `true` to enable automated database backups to S3.
- `BACKUP_CRON`: Cron expression for the backup schedule (Default: `0 3 * * *` — 3 AM daily).
- `BACKUP_RETENTION`: Number of recent backups to keep on S3 (Default: `7`).

---

## Health Checks & Probes

For container orchestrators (Kubernetes) or PaaS platforms (Render, Railway):

- **Liveness Probe**: `GET /health`
  Returns HTTP 200 indicating the Node.js process is running and able to accept HTTP requests.

- **Readiness Probe**: `GET /ready`
  Returns HTTP 200 only if the application is fully ready to serve traffic. This actively verifies:
  1. PostgreSQL connection is alive.
  2. Redis connection is alive (if `REDIS_URL` was provided).
  3. S3/Storage module is initialized.

- **Metrics Endpoint**: `GET /metrics`
  Placeholder endpoint for Prometheus scraping.

---

## Graceful Shutdown

The application is built to handle zero-downtime deployments. 

When receiving a `SIGTERM` or `SIGINT` (such as when Docker restarts the container or Render rolls out a new deployment), the server will:
1. Immediately stop accepting new HTTP connections.
2. Wait for all active HTTP requests, file uploads, and webhook processing tasks to complete.
3. Cleanly close the PostgreSQL connection pool.
4. Cleanly disconnect from Redis.
5. Flush all remaining logs.
6. Exit the process with status code 0.

---

## Running Locally with Docker

You can launch the complete stack (App, PostgreSQL, Redis, MinIO) locally:

```bash
docker-compose up --build
```

- **App**: `http://localhost:3000`
- **MinIO Console**: `http://localhost:9001` (Credentials: minioadmin / minioadmin)
