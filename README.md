# Prerender Clone

Express-based prerender service backed by Redis for caching and RabbitMQ for coordinating asynchronous Chromium renders.

## Architecture

1. Client hits `GET /prerender?url=<encoded>` on this service.
2. The service checks Redis for the cached physical path of that URL.
3. If the file exists the HTML is streamed straight from disk.
4. Otherwise the server generates a unique queue id, advertises it in the payload, and publishes a request to RabbitMQ.
5. The server waits up to 60 seconds for a response message on the same queue (the worker must reply there with the file path). If no response arrives, the request times out.
6. On success the HTML is returned and the URL → path mapping is cached in Redis for future hits.

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

Values can be provided via real environment variables or a local `.env` file (loaded automatically via [dotenv](https://www.npmjs.com/package/dotenv)).

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
# Development (runs directly via ts-node loader to preserve decorator metadata)
npm run dev

# Production build + run
npm run build
npm start
```

Request prerendered HTML:

```bash
curl 'http://localhost:3000/prerender?url=https%3A%2F%2Fexample.com'
```

### RabbitMQ contract

- Requests are JSON payloads containing `url`, `queueId` (the queue to reply on), and `requestedAt`.
- The worker is expected to fetch the page (likely via Puppeteer), write the HTML to the filesystem, and send a JSON response back to `queueId` with the same `correlationId`. A successful payload should look like `{ "path": "/absolute/or/relative/path.html" }`. Include an `error` string for failures.
- The server acknowledges the first message whose `correlationId` matches and tears down the temporary queue. Responses arriving after 60 seconds are ignored.

### Redis cache

- Keys follow `CACHE_PREFIX + url`.
- Values are the physical path to the rendered HTML file.
- When cache hits but the file no longer exists, that entry is ignored and a fresh render is requested.

## Legacy CLI

The original Puppeteer script is still available if you need a simple manual render:

```bash
npm run render -- https://example.com --output dist/example.html
```

It runs outside the Express/Rabbit/Redis workflow and simply writes the HTML to the provided path.
