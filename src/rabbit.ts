import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type Replies,
} from 'amqplib';
import crypto from 'crypto';
import { singleton } from 'tsyringe';
import { ConfigService } from './config.js';
import { logger } from './logger.js';

export interface RenderResponsePayload {
  path?: string;
  error?: string;
  [key: string]: unknown;
}

@singleton()
export class RabbitClient {
  private readonly url: string;
  private readonly requestQueue: string;
  private readonly responseQueuePrefix: string;
  private readonly responseTimeoutMs: number;

  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get();
    this.url = config.amqpUrl;
    this.requestQueue = config.requestQueue;
    this.responseQueuePrefix = config.responseQueuePrefix;
    this.responseTimeoutMs = config.responseTimeoutMs;
  }

  private async ensureConnection(): Promise<void> {
    if (this.connection) {
      return;
    }
    this.connection = await connect(this.url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.requestQueue, { durable: true });
  }

  async requestRender(targetUrl: string): Promise<RenderResponsePayload> {
    await this.ensureConnection();
    logger.info({ url: targetUrl }, 'Publishing render request');
    const channel = this.ensureChannel();

    const correlationId = crypto.randomUUID();
    const responseQueue = `${this.responseQueuePrefix}${correlationId}`;

    await channel.assertQueue(responseQueue, {
      exclusive: true,
      durable: false,
      autoDelete: true,
    });

    const payload = {
      url: targetUrl,
      queueId: responseQueue,
      requestedAt: new Date().toISOString(),
    };

    await channel.sendToQueue(
      this.requestQueue,
      Buffer.from(JSON.stringify(payload)),
      {
        replyTo: responseQueue,
        contentType: 'application/json',
        persistent: true,
      },
    );

    return this.waitForResponse({
      queueName: responseQueue,
      correlationId,
      channel,
      url: targetUrl,
    });
  }

  private waitForResponse({
    queueName,
    correlationId,
    channel,
    url,
  }: {
    queueName: string;
    correlationId: string;
    channel: Channel;
    url: string;
  }): Promise<RenderResponsePayload> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let consumerTag: string | undefined;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup().finally(() => reject(new Error(`Render response timed out for ${url}`)));
      }, this.responseTimeoutMs);

      const cleanup = async () => {
        clearTimeout(timeout);
        if (consumerTag) {
          try {
            await channel.cancel(consumerTag);
          } catch (error) {
            console.warn('[amqp] failed to cancel consumer', error);
          }
        }
        try {
          await channel.deleteQueue(queueName);
        } catch (error) {
          console.warn('[amqp] failed to delete response queue', error);
        }
      };

      channel
        .consume(
          queueName,
          (msg: ConsumeMessage | null) => {
            if (!msg || settled) {
              return;
            }

            if (msg.properties.correlationId !== correlationId) {
              channel.ack(msg);
              return;
            }

            settled = true;
            channel.ack(msg);
            cleanup().catch(() => {});

            try {
              const parsed = JSON.parse(msg.content.toString('utf8')) as RenderResponsePayload;
              logger.info({ url, correlationId, payload: parsed }, 'Received worker response');
              resolve(parsed);
            } catch (error) {
              reject(new Error('Invalid JSON response from renderer'));
            }
          },
          { noAck: false },
        )
        .then(({ consumerTag: tag }: Replies.Consume) => {
          consumerTag = tag;
        })
        .catch((error: unknown) => {
          settled = true;
          cleanup().catch(() => {});
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async close(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.close();
      } catch (error) {
        logger.warn({ error }, '[amqp] channel close error');
      } finally {
        this.channel = null;
      }
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        logger.warn({ error }, '[amqp] connection close error');
      } finally {
        this.connection = null;
      }
    }
  }

  private ensureChannel(): Channel {
    if (!this.channel) {
      throw new Error('AMQP channel is not initialized');
    }
    return this.channel;
  }

  async respond(queueName: string, payload: RenderResponsePayload): Promise<void> {
    await this.ensureConnection();
    const channel = this.ensureChannel();
    logger.info({ queueName, payload }, 'Sending worker response');
    await channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), {
      contentType: 'application/json',
      persistent: false,
    });
  }

  async consumeRequests(handler: (task: RenderTask) => Promise<void>): Promise<void> {
    await this.ensureConnection();
    const channel = this.ensureChannel();
    await channel.consume(
      this.requestQueue,
      async (msg) => {
        if (!msg) {
          return;
        }
        try {
          const task = JSON.parse(msg.content.toString('utf8')) as RenderTask;
          logger.info(task, 'Worker received task');
          await handler(task);
          channel.ack(msg);
        } catch (error) {
          logger.error({ error }, 'Failed to process task');
          channel.nack(msg, false, false);
        }
      },
      { noAck: false },
    );
  }
}

interface RenderTask {
  url: string;
  queueId: string;
  requestedAt: string;
}
