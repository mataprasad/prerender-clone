using System;
using System.IO;

namespace Prerender.Shared;

public sealed class AppConfig
{
    public int Port { get; init; }
    public string RedisUrl { get; init; } = "";
    public string CachePrefix { get; init; } = "";
    public int CacheTtlSeconds { get; init; }
    public string OutputDir { get; init; } = "";
    public string AmqpUrl { get; init; } = "";
    public string RequestQueue { get; init; } = "";
    public string ResponseQueuePrefix { get; init; } = "";
    public int ResponseTimeoutMs { get; init; }
    public int WorkerConcurrency { get; init; }
    public int WorkerThreadCount { get; init; }

    public static string DefaultOutputDir() => Path.Combine(Directory.GetCurrentDirectory(), "dist");
}
