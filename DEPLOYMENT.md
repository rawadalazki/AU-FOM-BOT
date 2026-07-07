# FOMbot Cloud Deployment Guide

This guide covers how to deploy FOMbot as a cloud-native, stateless application.

## Section 1: Environment Variables Reference

| Variable | Description | Required | Example |
|---|---|---|---|
| `PORT` | The port the HTTP server listens on | No (default: 3000) | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | Yes | `postgresql://user:pass@host:5432/db` |
| `S3_ENDPOINT` | The S3 API endpoint URL | Yes | `https://<ID>.r2.cloudflarestorage.com` |
| `S3_REGION` | S3 Region | No (default: auto) | `auto` |
| `S3_BUCKET` | S3 Bucket Name | Yes | `fombot-uploads` |
| `S3_ACCESS_KEY` | S3 Access Key ID | Yes | `...` |
| `S3_SECRET_KEY` | S3 Secret Access Key | Yes | `...` |
| `S3_PUBLIC_URL` | Public URL for the bucket (if public access is enabled) | No | `https://pub-<id>.r2.dev` |
| `WEBHOOK_URL` | The public HTTPS URL where your app is hosted | Yes | `https://fombot.onrender.com` |
| `WEBHOOK_SECRET` | Secret token to verify Telegram webhooks | Yes | `your-random-secret-string` |

## Section 2: Local Development with Docker Compose

1. Install Docker and Docker Compose.
2. Run `docker-compose up --build`
3. The app will be available at `http://localhost:3000`.
4. MinIO console (S3) is at `http://localhost:9001` (login: `minioadmin` / `minioadmin`).
5. To test webhooks locally, use ngrok: `ngrok http 3000` and set `WEBHOOK_URL` to your ngrok URL.

## Section 3: Deploy to Render

Render is the recommended platform.

1. Create a new **Web Service** on Render, connected to your Git repository.
2. Under "Environment", select **Docker**.
3. Add a **PostgreSQL** addon from the Render dashboard (the free tier works).
4. Render will automatically set the `DATABASE_URL` environment variable for your Web Service.
5. In the Web Service Environment Variables, set the S3 and Webhook variables:
   - `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
   - `WEBHOOK_URL`: `https://your-service-name.onrender.com`
   - `WEBHOOK_SECRET`: generate a random string
6. The app will automatically deploy when you push to your repository. Health checks are handled automatically by Render based on the Dockerfile.

## Section 4: Deploy to Railway

1. Install Railway CLI: `npm i -g @railway/cli`
2. Run `railway init` and `railway up`.
3. In the Railway dashboard, add a PostgreSQL plugin.
4. Set the environment variables in the Railway dashboard. Railway automatically provides `DATABASE_URL`.
5. Set `WEBHOOK_URL` to the public domain Railway assigns.

## Section 5: Deploy to Fly.io

1. Install `flyctl`.
2. Run `fly launch` (it will detect the Dockerfile).
3. Run `fly postgres create` and attach it to your app.
4. Set secrets using `fly secrets set S3_ACCESS_KEY=... S3_SECRET_KEY=... WEBHOOK_SECRET=...`
5. Run `fly deploy`.

## Section 6: Deploy to any VPS with Docker

1. Install Docker and Docker Compose on your server.
2. Clone your repository.
3. Copy `.env.example` to `.env` and fill in your production values.
4. Run `docker-compose up -d`.
5. Set up a reverse proxy (like Nginx, Caddy, or Traefik) to handle HTTPS and forward traffic to port 3000. Let's Encrypt can provide free SSL certificates.

## Section 7: Cloudflare R2 Setup

Cloudflare R2 is the recommended S3-compatible storage due to its generous free tier.

1. Go to Cloudflare Dashboard → R2.
2. Create a bucket named `fombot-uploads`.
3. In R2 Settings, click "Manage R2 API Tokens" and create a new token with **Object Read & Write** permissions.
4. Copy the Account ID (from the dashboard URL or R2 overview), Access Key ID, and Secret Access Key.
5. Set `S3_ENDPOINT` to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

## Section 8: Post-Deployment Verification

1. **Health Check**: Open `https://your-app-url/api/health` in your browser. It should return `{"status":"ok"}`.
2. **Webhook Check**: Go to `https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo` to verify that the webhook URL is correctly set to your application.
3. **App Functionality**: Open the Admin Panel, create a faculty, and verify that the bot responds to messages. Upload a file and verify it can be downloaded.
