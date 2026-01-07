import { Worker } from 'node:worker_threads';
import os from 'os';

const WORKER_COUNT = Number(process.env.WORKER_THREADS || os.cpus().length);
const workers: Worker[] = [];

for (let i = 0; i < WORKER_COUNT; i += 1) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    execArgv: ['--loader', 'ts-node/esm'],
    env: process.env,
  });

  worker.on('online', () => {
    console.log(`Worker thread #${i + 1} online`);
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`Worker thread #${i + 1} exited with code ${code}`);
    } else {
      console.log(`Worker thread #${i + 1} exited`);
    }
  });

  worker.on('error', (err) => {
    console.error(`Worker thread #${i + 1} error`, err);
  });

  workers.push(worker);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  console.log('Shutting down worker threads...');
  for (const worker of workers) {
    worker.terminate().catch((err) => {
      console.error('Failed to terminate worker thread', err);
    });
  }
}
