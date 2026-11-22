using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace HubWatch.Realtime;

/// <summary>Fans out messages to every connected browser (Server-Sent Events).</summary>
public sealed class EventBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<string>> _subscribers = new();

    public (Guid Id, ChannelReader<string> Reader) Subscribe()
    {
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(1000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });
        var id = Guid.NewGuid();
        _subscribers[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel))
            channel.Writer.TryComplete();
    }

    public void Publish(string eventName, object payload)
    {
        var message = Format(eventName, payload);
        foreach (var channel in _subscribers.Values)
            channel.Writer.TryWrite(message);
    }

    public static string Format(string eventName, object payload) =>
        $"event: {eventName}\ndata: {JsonSerializer.Serialize(payload, JsonSerializerOptions.Web)}\n\n";
}
