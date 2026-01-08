using System;
using System.IO;

namespace Prerender.Shared;

public sealed class ConfigService
{
    private readonly AppConfig _config;

    public ConfigService()
    {
        _config = BuildConfig();
    }

    public AppConfig Get() => _config;

    private static AppConfig BuildConfig()
    {
        var port = GetInt("PORT", 3000);
        var cacheTtlSeconds = GetInt("CACHE_TTL_SECONDS", 60 * 60);
        var outputDir = Environment.GetEnvironmentVariable("OUTPUT_DIR");

        return new AppConfig
        {
            Port = port,
            RedisUrl = GetString("REDIS_URL", "localhost:6379"),
            CachePrefix = GetString("CACHE_PREFIX", "prerender:url:"),
            CacheTtlSeconds = cacheTtlSeconds,
            OutputDir = string.IsNullOrWhiteSpace(outputDir)
                ? AppConfig.DefaultOutputDir()
                : Path.GetFullPath(outputDir),
            AmqpUrl = GetString("AMQP_URL", "amqp://localhost"),
            RequestQueue = GetString("RENDER_REQUEST_QUEUE", "prerender.requests"),
            ResponseQueuePrefix = GetString("RESPONSE_QUEUE_PREFIX", "prerender.responses."),
            ResponseTimeoutMs = GetInt("RESPONSE_TIMEOUT_MS", 60_000),
            WorkerConcurrency = GetInt("WORKER_CONCURRENCY", 3),
            WorkerThreadCount = GetInt("WORKER_THREADS", Environment.ProcessorCount),
        };
    }

    private static int GetInt(string name, int fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) ? value : fallback;
    }

    private static string GetString(string name, string fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(raw) ? fallback : raw;
    }
}
