using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using Prerender.Shared.Models;

namespace Prerender.Shared;

public sealed class RabbitClient : IAsyncDisposable
{
    private readonly ConfigService _configService;
    private readonly ILogger<RabbitClient> _logger;
    private readonly object _channelLock = new();
    private IConnection? _connection;
    private IModel? _channel;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public RabbitClient(ConfigService configService, ILogger<RabbitClient> logger)
    {
        _configService = configService;
        _logger = logger;
    }

    private AppConfig Config => _configService.Get();

    private void EnsureConnection()
    {
        if (_connection != null)
        {
            return;
        }

        var factory = new ConnectionFactory
        {
            Uri = new Uri(Config.AmqpUrl),
            DispatchConsumersAsync = true,
        };

        _connection = factory.CreateConnection();
        _channel = _connection.CreateModel();
        _channel.QueueDeclare(queue: Config.RequestQueue, durable: true, exclusive: false, autoDelete: false);
    }

    private IModel EnsureChannel()
    {
        if (_channel == null)
        {
            throw new InvalidOperationException("AMQP channel is not initialized");
        }
        return _channel;
    }

    public Task ConsumeRequestsAsync(Func<RenderTask, Task> handler, ushort? prefetchCount = null)
    {
        EnsureConnection();
        var channel = EnsureChannel();

        if (prefetchCount.HasValue)
        {
            channel.BasicQos(0, prefetchCount.Value, false);
        }

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.Received += async (_, args) =>
        {
            RenderTask? task = null;
            try
            {
                using (var ms = new MemoryStream(args.Body.Span.ToArray()))
                    task = await JsonSerializer.DeserializeAsync<RenderTask>(ms, JsonOptions);
                if (task == null)
                {
                    throw new InvalidOperationException("Empty render task payload");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse render task");
                lock (_channelLock)
                {
                    channel.BasicNack(args.DeliveryTag, false, false);
                }
                return;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    _logger.LogInformation("Worker received task {Url}", task.Url);
                    await handler(task);
                    lock (_channelLock)
                    {
                        channel.BasicAck(args.DeliveryTag, false);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to process render task {Url}", task.Url);
                    lock (_channelLock)
                    {
                        channel.BasicNack(args.DeliveryTag, false, false);
                    }
                }
            });
        };

        lock (_channelLock)
        {
            channel.BasicConsume(queue: Config.RequestQueue, autoAck: false, consumer: consumer);
        }

        return Task.CompletedTask;
    }

    public Task RespondAsync(string queueName, RenderResponsePayload payload)
    {
        EnsureConnection();
        var channel = EnsureChannel();
        var body = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
        var props = channel.CreateBasicProperties();
        props.ContentType = "application/json";
        props.CorrelationId = payload.CorrelationId;

        lock (_channelLock)
        {
            channel.BasicPublish(exchange: string.Empty, routingKey: queueName, basicProperties: props, body: body);
        }

        _logger.LogInformation("Sent worker response {Queue}", queueName);
        return Task.CompletedTask;
    }

    public Task<RenderResponsePayload> RequestRenderAsync(string targetUrl, CancellationToken cancellationToken = default)
    {
        EnsureConnection();
        var channel = EnsureChannel();

        var correlationId = Guid.NewGuid().ToString("N");
        var responseQueue = $"{Config.ResponseQueuePrefix}{correlationId}";

        lock (_channelLock)
        {
            channel.QueueDeclare(queue: responseQueue, durable: false, exclusive: true, autoDelete: true);
        }

        var payload = new RenderTask
        {
            Url = targetUrl,
            QueueId = responseQueue,
            RequestedAt = DateTimeOffset.UtcNow.ToString("o"),
            CorrelationId = correlationId,
        };

        var body = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
        var props = channel.CreateBasicProperties();
        props.CorrelationId = correlationId;
        props.ReplyTo = responseQueue;
        props.ContentType = "application/json";
        props.Persistent = true;

        _logger.LogInformation("Publishing render request {Url}", targetUrl);
        lock (_channelLock)
        {
            channel.BasicPublish(exchange: string.Empty, routingKey: Config.RequestQueue, basicProperties: props, body: body);
        }

        return WaitForResponseAsync(channel, responseQueue, correlationId, targetUrl, cancellationToken);
    }

    private async Task<RenderResponsePayload> WaitForResponseAsync(
        IModel channel,
        string queueName,
        string correlationId,
        string url,
        CancellationToken cancellationToken)
    {
        var tcs = new TaskCompletionSource<RenderResponsePayload>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? consumerTag = null;

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(Config.ResponseTimeoutMs);

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.Received += async (_, args) =>
        {
            if (args.BasicProperties?.CorrelationId != correlationId)
            {
                lock (_channelLock)
                {
                    channel.BasicAck(args.DeliveryTag, false);
                }
                return;
            }

            try
            {
                var payload = JsonSerializer.Deserialize<RenderResponsePayload>(args.Body.Span, JsonOptions);
                if (payload == null)
                {
                    throw new InvalidOperationException("Invalid response payload");
                }

                lock (_channelLock)
                {
                    channel.BasicAck(args.DeliveryTag, false);
                }

                _logger.LogInformation("Received render response {Url}", url);
                tcs.TrySetResult(payload);
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }

            await Task.CompletedTask;
        };

        lock (_channelLock)
        {
            consumerTag = channel.BasicConsume(queue: queueName, autoAck: false, consumer: consumer);
        }

        using var registration = timeoutCts.Token.Register(() =>
        {
            tcs.TrySetException(new TimeoutException($"Render response timed out for {url}"));
        });

        try
        {
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            if (consumerTag != null)
            {
                try
                {
                    lock (_channelLock)
                    {
                        channel.BasicCancel(consumerTag);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to cancel response consumer");
                }
            }

            try
            {
                lock (_channelLock)
                {
                    channel.QueueDelete(queueName);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to delete response queue {Queue}", queueName);
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        if (_channel != null)
        {
            try
            {
                _channel.Close();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "AMQP channel close error");
            }
            _channel = null;
        }

        if (_connection != null)
        {
            try
            {
                _connection.Close();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "AMQP connection close error");
            }
            _connection = null;
        }

        return ValueTask.CompletedTask;
    }
}
