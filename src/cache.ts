import { createClient, type RedisClientType } from 'redis';
import { singleton } from 'tsyringe';
import { ConfigService, type AppConfig } from './config.js';

@singleton()
export class CacheService {
  private readonly client: RedisClientType;
  private readonly config: AppConfig;
  private connected = false;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.get();
    this.client = createClient({ url: this.config.redisUrl });
    this.client.on('error', (err) => {
      console.error('[redis] connection error', err);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.client.connect();
    this.connected = true;
  }

  private buildKey(targetUrl: string): string {
    return `${this.config.cachePrefix}${targetUrl}`;
  }

  async getUrl(targetUrl: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(this.buildKey(targetUrl));
  }

  async setUrl(targetUrl: string, filePath: string): Promise<string | null> {
    await this.ensureConnected();
    const key = this.buildKey(targetUrl);
    const ttl = this.config.cacheTtlSeconds;
    if (ttl > 0) {
      return this.client.set(key, filePath, { EX: ttl });
    }
    return this.client.set(key, filePath);
  }

  async close(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.client.quit();
    } catch (error) {
      console.warn('[redis] shutdown error', error);
    } finally {
      this.connected = false;
    }
  }
}
