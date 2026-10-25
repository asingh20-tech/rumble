# Runtime arena artwork

- `arena-platform.png`: transparent 1024 × 1024 top-down platform render.
- `arena-metadata.json`: orthographic camera scale and platform radius for alignment.

Editable Blender source, portable model, and regeneration script are in the
repository's `design/` directory. From the `rumble` directory, regenerate with:

```bash
blender --background --factory-startup --python design/build_arena.py
```

The script keeps `.blend`/`.glb` files outside the client and refreshes only the
PNG and alignment metadata here. Phaser scales the image using the current
`ARENA.platformRadius`, leaving transparent padding for glow. Stars, particles,
players, labels, and trails are rendered live.
