import 'reflect-metadata';
import type { Server } from 'http';
import dotenv from 'dotenv';
import express, { type Express } from 'express';
import { container, singleton } from 'tsyringe';
import { ConfigService } from './config.js';
import { logger } from './logger.js';
import { PrerenderRoute } from './routes/prerender.js';
import { CacheService } from './cache.js';
import { RabbitClient } from './rabbit.js';

dotenv.config();

@singleton()
export class Application {
  private server: Server | null = null;

  private readonly app: Express;

  constructor(
    private readonly configService: ConfigService,
    private readonly prerenderRoute: PrerenderRoute,
    private readonly cacheService: CacheService,
    private readonly rabbitClient: RabbitClient,
  ) {
    this.app = express();
    this.app.use(express.json({ limit: '1mb' }));
    this.registerSystemRoutes();
    this.prerenderRoute.register(this.app);
  }

  private registerSystemRoutes(): void {
    this.app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    });
  }

  async start(): Promise<void> {
    const config = this.configService.get();
    await new Promise<void>((resolve, reject) => {
      this.server = this.app.listen(config.port, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    logger.info(`Prerender server listening on http://localhost:${config.port}`);

    process.on('SIGTERM', () => void this.shutdown());
    process.on('SIGINT', () => void this.shutdown());
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down...');
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      this.server = null;
    }

    await Promise.allSettled([this.cacheService.close(), this.rabbitClient.close()]);
    process.exit(0);
  }
}

const application = container.resolve(Application);

application.start().catch((error: unknown) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
