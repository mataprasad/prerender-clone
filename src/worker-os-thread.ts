import { Worker } from 'node:worker_threads';
import 'reflect-metadata';
import { container } from 'tsyringe';
import { ConfigService } from './config.js';
import { logger } from './logger.js';

const WORKER_COUNT = container.resolve(ConfigService).get().workerThreadCount;
const workers: Worker[] = [];

for (let i = 0; i < WORKER_COUNT; i += 1) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    execArgv: ['--loader', 'ts-node/esm'],
    env: process.env,
  });

  worker.on('online', () => {
    logger.info({ thread: i + 1 }, 'Worker thread online');
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      logger.error({ thread: i + 1, code }, 'Worker thread exited with error');
    } else {
      logger.info({ thread: i + 1 }, 'Worker thread exited');
    }
  });

  worker.on('error', (err) => {
    logger.error({ thread: i + 1, err }, 'Worker thread error');
  });

  workers.push(worker);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  logger.info('Shutting down worker threads...');
  for (const worker of workers) {
    worker.terminate().catch((err) => {
      logger.error({ err }, 'Failed to terminate worker thread');
    });
  }
}
