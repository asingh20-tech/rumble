# Host arena renderer (M4)

`HostPage` switches from lobby to `GameCanvas` only when the room snapshot phase
is `playing`. `components/hostGameStream.js` subscribes to the shared socket's
`EVENTS.GAME_STATE`, joins each player ID with the latest room's name/color,
and calls the canvas ref directly. It does not store frame data in React state.
Frames received before Phaser boots are retained in a small bounded queue.

`SnapshotInterpolation.js` estimates the server clock from `serverTime` and local
monotonic receipt time. It interpolates about 100 ms behind that clock, freezes
at the last authoritative position during packet loss, ignores stale ticks, and
resets after long gaps or room/round transitions. At 30 Hz, this needs up to five
position samples (three tick intervals plus interpolation endpoints). Player
membership and connectivity change on the delayed render timeline.

`gameRuntime.js` serializes creation and destruction. Phaser's public `destroy()`
finishes on a future frame; a replacement waits for its destruction event, so
StrictMode, remounts, and Vite hot refresh cannot overlap game instances.

The PNG and projection metadata in `assets/` are runtime artwork. Editable Blender
models and their generator live in the repository's `design/` directory. There
is no preview route or locally animated sample-player implementation in the app.

Run the focused pipeline/interpolation/lifecycle checks from the `rumble` folder:

```bash
node --test client/src/game/*.node.test.js
```

The existing workspace checks remain `npm test` and `npm run build`. This renderer
consumes the frozen shared protocol; it does not implement physics or phone inputs.
