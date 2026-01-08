using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Prerender.Shared;
using Prerender.Worker;

dotenv.net.DotEnv.Load();

var builder = Host.CreateApplicationBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options =>
{
    options.IncludeScopes = true;
    options.SingleLine = true;
    options.TimestampFormat = "HH:mm:ss ";
});

builder.Services.AddSingleton<ConfigService>();
builder.Services.AddSingleton<CacheService>();
builder.Services.AddSingleton<RabbitClient>();
builder.Services.AddHostedService<WorkerHostedService>();

var host = builder.Build();
await host.RunAsync();
