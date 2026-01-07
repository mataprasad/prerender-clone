import path from 'path';
import { singleton } from 'tsyringe';

export interface AppConfig {
  port: number;
  redisUrl: string;
  cachePrefix: string;
  cacheTtlSeconds: number;
  outputDir: string;
  amqpUrl: string;
  requestQueue: string;
  responseQueuePrefix: string;
  responseTimeoutMs: number;
}

@singleton()
export class ConfigService {
  private readonly config: AppConfig = this.buildConfig();

  get(): AppConfig {
    return this.config;
  }

  private buildConfig(): AppConfig {
    const env = process.env;
    const port = Number(env.PORT || 3000);
    const cacheTtlSeconds = Number(env.CACHE_TTL_SECONDS || 60 * 60);
    const outputDir = env.OUTPUT_DIR || path.join(process.cwd(), 'dist');

    return {
      port,
      redisUrl: env.REDIS_URL || 'redis://localhost:6379',
      cachePrefix: env.CACHE_PREFIX || 'prerender:url:',
      cacheTtlSeconds,
      outputDir,
      amqpUrl: env.AMQP_URL || 'amqp://localhost',
      requestQueue: env.RENDER_REQUEST_QUEUE || 'prerender.requests',
      responseQueuePrefix:
        env.RESPONSE_QUEUE_PREFIX || 'prerender.responses.',
      responseTimeoutMs: Number(env.RESPONSE_TIMEOUT_MS || 60_000),
    };
  }
}
