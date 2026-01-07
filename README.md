# Prerender Clone

Express-based prerender service backed by Redis for caching and RabbitMQ for coordinating asynchronous Chromium renders.

## Architecture

1. Client hits `GET /prerender?url=<encoded>` on this service.
2. The service checks Redis for the cached physical path of that URL.
3. If the file exists the HTML is streamed straight from disk.
4. Otherwise the service publishes a request to RabbitMQ specifying the URL and a per-request response queue.
5. A separate worker (see below) consumes requests, prerenders the page with Puppeteer, saves the HTML to disk, caches the path in Redis, and replies on the provided queue.
6. The HTTP service waits up to 60 seconds for the worker's response. If no response arrives the request times out.

## Requirements

- Node.js 18+
- Redis instance (default `redis://localhost:6379`)
- RabbitMQ broker (default `amqp://localhost`)

## Setup

```bash
npm install
# optional: customize environment variables
cp .env.example .env
```

## Configuration

Values can be provided via environment variables or a `.env` file.

Environment variable | Default | Description
--- | --- | ---
`PORT` | `3000` | Express server port.
`REDIS_URL` | `redis://localhost:6379` | Connection string for Redis.
`CACHE_PREFIX` | `prerender:url:` | Redis key prefix.
`CACHE_TTL_SECONDS` | `3600` | Expiration for cached URL → file mappings.
`OUTPUT_DIR` | `<repo>/dist` | Root folder that stores rendered HTML files.
`AMQP_URL` | `amqp://localhost` | RabbitMQ connection string.
`RENDER_REQUEST_QUEUE` | `prerender.requests` | Queue where render jobs are published.
`RESPONSE_QUEUE_PREFIX` | `prerender.responses.` | Prefix for the per-request response queue.
`RESPONSE_TIMEOUT_MS` | `60000` | How long the server waits for a render response.

## Running

```bash
# Development server (ts-node loader preserves decorator metadata)
npm run dev

# Worker (consume jobs and render pages)
npm run worker

# Production build + run
npm run build
npm start
```

Request prerendered HTML:

```bash
curl 'http://localhost:3000/prerender?url=https%3A%2F%2Fexample.com'
```

### RabbitMQ contract

- Requests are JSON payloads containing `url`, `queueId`, and `requestedAt`.
- The worker fetches the page, writes HTML to disk, caches the path in Redis, and responds on `queueId` with `{ "path": "<absolute/path>" }`.
- Include an `error` string for failures. The server tears down temporary queues once a response arrives.

### Redis cache

- Keys follow `CACHE_PREFIX + url`.
- Values are the physical path to the rendered HTML file.
- When cache hits but the file no longer exists, the entry is ignored and a fresh render is requested.

## Legacy CLI

The original Puppeteer script is still available for manual renders:

```bash
npm run render -- https://example.com --output dist/example.html
```

