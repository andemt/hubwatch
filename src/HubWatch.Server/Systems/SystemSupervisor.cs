using System.Text.Json.Nodes;
using HubWatch.Config;
using HubWatch.Data;

namespace HubWatch.Systems;

/// <summary>
/// Runs one collector per configured system and keeps them in line with the configuration.
/// Each collector reconnects on its own with back-off, so one unreachable system never affects the others.
///
/// Runs inside the web app for now (v1). Collectors only depend on the database and shared services,
/// so they can later run in a standalone background service (v2).
/// </summary>
public sealed class SystemSupervisor(
    ConfigStore config,
    Database db,
    SystemRegistry registry,
    IEnumerable<ISystemAdapter> adapters,
    ILogger<SystemSupervisor> logger) : BackgroundService
{
    private sealed record Running(SystemRuntime Runtime, CancellationTokenSource Cts, Task Task);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, Running> _running = new();
    private CancellationToken _stopping;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _stopping = stoppingToken;
        db.CloseStaleSessions();
        await ReconcileAsync();

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }

        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            await Task.WhenAll(_running.Values.Select(StopAsync));
            _running.Clear();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Starts collectors for new systems and stops those for removed or changed ones. Returns when stopped
    /// collectors have finished (their sessions are closed), so their data can safely be deleted afterwards.
    /// </summary>
    public async Task ReconcileAsync()
    {
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            var wanted = config.Systems;

            foreach (var (id, running) in _running.ToList())
            {
                if (wanted.Contains(running.Runtime.Config)) continue;
                await StopAsync(running);
                _running.Remove(id);
            }

            foreach (var system in wanted)
            {
                if (_running.ContainsKey(system.Id)) continue;
                var adapter = adapters.FirstOrDefault(a => a.Kind == system.Kind);
                if (adapter is null)
                {
                    logger.LogWarning("No adapter for system kind {Kind}; {Id} is ignored", system.Kind, system.Id);
                    continue;
                }

                db.EnsureSystem(system);
                var runtime = new SystemRuntime(system, adapter.CreateResources(system.Id), registry.PublishStatus);
                RestoreResources(runtime); // shows the last known devices until it connects
                var cts = CancellationTokenSource.CreateLinkedTokenSource(_stopping);
                var task = Task.Run(() => RunLoopAsync(adapter, runtime, cts.Token), CancellationToken.None);
                _running[system.Id] = new Running(runtime, cts, task);
            }

            registry.Set([.. wanted.Select(s => _running.GetValueOrDefault(s.Id)?.Runtime).OfType<SystemRuntime>()]);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task StopAsync(Running running)
    {
        await running.Cts.CancelAsync();
        try
        {
            await running.Task;
        }
        catch (OperationCanceledException)
        {
            // expected
        }
        running.Cts.Dispose();
    }

    private void RestoreResources(SystemRuntime system)
    {
        try
        {
            if (db.LoadResourceSnapshot(system.Id) is not { } saved || JsonNode.Parse(saved.Data) is not { } data) return;
            system.Resources.Restore(data);
            system.SetResourcesAsOf(saved.SavedAt);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not restore the last known devices of {System}", system.DisplayName);
        }
    }

    private void SaveResources(SystemRuntime system)
    {
        if (!system.Resources.IsLoaded) return;
        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            db.SaveResourceSnapshot(system.Id, now, system.Resources.Export().ToJsonString());
            system.SetResourcesAsOf(now);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not save the last known devices of {System}", system.DisplayName);
        }
    }

    /// <summary>How long a system may keep failing before its collector gives up and waits for the user.</summary>
    private static readonly TimeSpan GiveUpAfter = TimeSpan.FromSeconds(120);

    /// <summary>Shorter limit after the user asks to try again: they are waiting for the answer.</summary>
    private static readonly TimeSpan GiveUpAfterRetry = TimeSpan.FromSeconds(30);

    private async Task RunLoopAsync(ISystemAdapter adapter, SystemRuntime system, CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        var unreachableLogged = false; // log an unreachable system once per outage, not on every retry
        DateTimeOffset? failingSince = null; // when the current run of failed attempts started
        var giveUpAfter = GiveUpAfter;

        while (!ct.IsCancellationRequested)
        {
            // Cancelled when the user presses Stop; covers both the attempt and the wait before the next one.
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct, system.StopToken);
            var attemptStarted = DateTimeOffset.UtcNow;
            string? failure = null; // set when the attempt failed in a way that counts towards giving up
            var stopped = false;
            var connected = false;
            try
            {
                system.SetState(SystemState.Connecting, $"Connecting to {system.Config.Address}…");
                await adapter.RunAsync(system, () =>
                {
                    connected = true;
                    SaveResources(system);
                    backoff = TimeSpan.FromSeconds(2);
                    failingSince = null;
                    giveUpAfter = GiveUpAfter; // a later outage gets the full time again
                    if (unreachableLogged)
                    {
                        logger.LogInformation("{System} ({Address}) is reachable again", system.DisplayName, system.Config.Address);
                        unreachableLogged = false;
                    }
                }, attempt.Token);
                system.SetState(SystemState.Reconnecting, "Connection closed by the system.");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception) when (system.StopToken.IsCancellationRequested)
            {
                stopped = true; // whatever the adapter threw while being stopped
            }
            catch (CertificateChangedException ex)
            {
                logger.LogWarning("{System} ({Address}) presented a different TLS certificate than the pinned one; not connecting",
                    system.DisplayName, system.Config.Address);
                system.SetCertificateChanged(ex.PresentedPin, ex.Message);
                backoff = TimeSpan.FromMinutes(1);
            }
            catch (UnauthorizedAccessException ex)
            {
                logger.LogWarning("{System}: {Message}", system.DisplayName, ex.Message);
                system.SetState(SystemState.Error, ex.Message);
                backoff = TimeSpan.FromMinutes(1);
            }
            catch (Exception ex) when (DescribeUnreachable(ex) is { } reason)
            {
                // Expected when the system is off or we're on another network: no stack trace, and only once per outage.
                if (!unreachableLogged)
                {
                    logger.LogWarning("Cannot reach {System} ({Address}): {Reason}. Retrying in the background.",
                        system.DisplayName, system.Config.Address, reason);
                    unreachableLogged = true;
                }
                else
                {
                    logger.LogDebug("Still cannot reach {System} ({Address}): {Reason}", system.DisplayName, system.Config.Address, reason);
                }
                system.SetState(SystemState.Reconnecting, $"Not found on this network ({reason}).");
                failure = reason;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Lost connection to {System} ({Address})", system.DisplayName, system.Config.Address);
                system.SetState(SystemState.Reconnecting, $"Cannot reach it: {ex.Message}");
                failure = ex.Message;
            }
            finally
            {
                // Keeps what changed while connected as the last known state, also when shutting down.
                if (connected) SaveResources(system);
            }

            string? offlineReason = null;
            if (stopped)
            {
                offlineReason = "Stopped trying.";
            }
            else if (failure is not null)
            {
                failingSince ??= attemptStarted;
                if (DateTimeOffset.UtcNow - failingSince >= giveUpAfter)
                {
                    var waited = giveUpAfter.TotalSeconds < 60 ? $"{(int)giveUpAfter.TotalSeconds} seconds" : $"{(int)giveUpAfter.TotalMinutes} minutes";
                    offlineReason = $"Gave up after {waited} ({failure}).";
                }
            }

            if (offlineReason is null)
            {
                try
                {
                    await Task.Delay(backoff, attempt.Token);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 60));
                    continue;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                catch (OperationCanceledException)
                {
                    offlineReason = "Stopped trying."; // Stop pressed while waiting for the next attempt
                }
            }

            // Offline: stop hammering a system that isn't there (e.g. we're on another network) and wait for the user.
            logger.LogWarning("Stopped trying to reach {System} ({Address}): {Reason} Waiting for the user to try again",
                system.DisplayName, system.Config.Address, offlineReason);
            var retry = system.RetryRequested; // taken before going offline, so no request is missed
            system.SetState(SystemState.Offline, offlineReason);
            system.ResetStop();
            try
            {
                await retry.WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            logger.LogInformation("Trying to reach {System} ({Address}) again on request", system.DisplayName, system.Config.Address);
            failingSince = null;
            unreachableLogged = false;
            backoff = TimeSpan.FromSeconds(2);
            giveUpAfter = GiveUpAfterRetry;
        }
    }

    /// <summary>
    /// Returns a short reason when <paramref name="ex"/> means the system could not be reached
    /// (timeout, refused, no route), or null for anything else. The caller has already ruled out
    /// cancellation by the app itself, so a remaining cancellation is a request timeout.
    /// </summary>
    private static string? DescribeUnreachable(Exception ex)
    {
        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            switch (e)
            {
                case TimeoutException:
                    return "connection timed out";
                case System.Net.Sockets.SocketException se:
                    return se.SocketErrorCode switch
                    {
                        System.Net.Sockets.SocketError.ConnectionRefused => "connection refused",
                        System.Net.Sockets.SocketError.HostUnreachable or System.Net.Sockets.SocketError.NetworkUnreachable => "no route to it",
                        System.Net.Sockets.SocketError.TimedOut => "connection timed out",
                        System.Net.Sockets.SocketError.HostNotFound => "address could not be resolved",
                        _ => se.Message,
                    };
                case HttpRequestException { HttpRequestError: HttpRequestError.ConnectionError or HttpRequestError.NameResolutionError } hre
                    when hre.InnerException is null:
                    return hre.Message;
            }
        }
        return ex is OperationCanceledException ? "request timed out" : null;
    }
}
