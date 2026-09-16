# Debugging audio cutouts on iPad

Run the **Skuzic** scheme on the iPad from Xcode (Command-R), and filter the
console for **[skuzic]**. A new launch prints **DIAGNOSTICS_READY version=2**.
These are default-level unified logs in subsystem **com.incubious.skuzic**,
with session, stream, audio, drawing, and planner categories. Diagnostics
contain timing, counts, and error codes, without keys, URLs, drawings, or prompts.

## Audio architecture

- **LyriaConnection** owns one ephemeral URLSession, a WebSocket, the setup
  timeout, and its receive task. It uses the documented v1beta music endpoint.
  Closing cancels the entire session and resolves any outstanding setup waiter.
- **LyriaOutbox** allows one in-flight send. Adjacent pending prompt/config
  updates coalesce; PLAY, PAUSE, STOP, and RESET_CONTEXT preserve ordering.
- **LyriaStream** receives and decodes PCM off the main actor. Unsupported
  formats and server errors are explicit failures.
- **PcmScheduler** owns AVAudioEngine, conversion, volume ramps, and player
  scheduling on one serial worker. The visualizer uses preallocated FFT
  storage and skips visual updates instead of waiting on a contested lock.
- **PlaybackTimeline** accounts for samples and identifies each playback
  generation. Completions from a stopped or replaced queue are ignored.
- **LyriaEngine** coordinates user intent and publishes actual playback state.
  It retains the latest prompts/config across up to three automatic reconnects
  with 1, 2, and 4 second delays. A fresh manual connection resets this budget.

## Buffering behavior

Playback initially waits for **4 seconds of PCM**. The first 2-second chunk
alone does not start the player. If the queue empties, the player stops and
collects a fresh reserve before resuming. The target increases to 6 seconds,
then at most 8 seconds. The UI displays **buffering** during this wait, while
the transport button still lets the user pause.

Generation pauses at 12 seconds queued and resumes below 6 seconds, while
local audio continues playing. A 20-second hard capacity prevents unbounded
memory growth if a peer ignores flow control.

User pause fades out over 80 ms and clears queued audio. Late incoming audio
is ignored while paused. Resume starts with fresh buffering. Reset commands
are ordered after config changes; old player callbacks cannot affect the new
queue. System interruptions suspend playback, and headphone removal pauses it.
Audio engine configuration changes and media-service resets rebuild/restart
the local engine when playback is still wanted.

A buffer absorbs jitter; it cannot make a persistently slower producer
sustain normal-speed playback indefinitely. The implementation preserves the
music's speed and reports rebuffering if incoming audio remains insufficient.
Fifteen seconds without new audio while generation is wanted triggers reconnect.

## Reproduce on device

1. Open a sketch and allow the initial buffer to fill.
2. Listen for at least a minute, first without drawing, then while drawing.
3. Note the approximate time of any cutout and retain the surrounding
   AUDIO_HEALTH and BUFFER_UNDERRUN lines.
4. Try pause/resume, background/foreground, and manual tempo changes.
5. Repeat with auto-interpret disabled to isolate the planner path.

Save the sketch by returning to the gallery before a terminal relaunch:

~~~sh
bash ios/scripts/run-device.sh "Not your iPad"
~~~

The script builds and installs a signed Debug app, launches it, and captures
output in a timestamped **.logs/ios-device-*.log**. It enables
**SKUZIC_DIAGNOSTICS_STDOUT=1** for devicectl. Pipe writes use a separate queue.
Ctrl-C stops the capture and running app; save the sketch first.

| Marker | Meaning |
| --- | --- |
| AUDIO_HEALTH | Worker summary every 2 seconds: phase, buffer_s, target_s, chunks, max_gap_ms, queue_ms, engine, underruns. |
| PLAYBACK_STARTED | The reserve is ready and the local player is starting. |
| BUFFER_UNDERRUN | The last audible buffer ended; rebuffering is required. |
| GENERATION_BACKPRESSURE | Only generation is paused/resumed to control queue size. |
| STREAM_STALLED / RECONNECT | No input for 15 seconds, or a connection failure, caused a fresh connection attempt. |
| CONNECTION_FAILED / SERVER_ERROR / PLAYBACK_FAILED | A transport, server, format, capacity, or audio-engine failure. |
| AUDIO_INTERRUPTION / AUDIO_ROUTE_CHANGED | A system interruption or route change; began=true identifies interruption start. |
| ENGINE_CONFIGURATION_CHANGED / ENGINE_RESTART_REQUESTED | The hardware configuration changed or the audio engine stopped. |
| RESET_CONTEXT_QUEUED / BUFFER_FLUSH | A deliberate reset or buffer clear, with its cause. |
| CONFIG_QUEUED / PROMPTS_QUEUED / PLAY_QUEUED / PAUSE_QUEUED | Commands accepted by the ordered outbox; a later CONNECTION_FAILED may report transmission failure. |
| STROKE_BEGIN / STROKE_END / EXPORT_BEGIN / EXPORT_END | Drawing and image-export timing. |
| PLAN_BEGIN / PLAN_APPLIED / PLAN_FAILED | Planner timing and outcome. A planner timeout skips that update; it does not itself stop music. |

The Info.plist, PencilKit gesture, and text reflow warnings alone do not
identify the cause of an audio cutout. Correlate them with playback diagnostics.

## Local regression checks

~~~sh
sh ios/scripts/test-audio.sh
~~~

Checks cover initial reserve, recovery, bounded queues, stale completions,
three minutes of jittery arrivals, sustained slow input, command ordering,
cancellation, format errors, reception while the main actor is blocked, and
drawing-safe prompt changes. They require macOS/Xcode but no API key or iPad.
Physical-device playback remains a separate verification step.
