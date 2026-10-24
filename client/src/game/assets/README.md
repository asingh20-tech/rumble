# RUMBLE arena source

The arena is modeled in Blender from generated geometry and materials. No external
models or image textures are used.

- `arena.blend`: editable source, with named deck, rim, guide, fastener and light objects.
- `arena.glb`: portable model export, without cameras or lights.
- `arena-platform.png`: transparent 1024 × 1024 orthographic render used by Phaser.
- `arena-metadata.json`: projection and alignment information from the successful build.
- `build_arena.py`: reproducible model, material, light, camera and render generator.

From the `rumble` directory, with Blender 4.5 LTS installed:

```bash
blender --background --factory-startup --python client/src/game/assets/build_arena.py
```

On macOS, substitute `/Applications/Blender.app/Contents/MacOS/Blender` if Blender
is not on `PATH`. Add `-- --samples 96` for a higher-sample render. The script reads
the arena dimensions and theme from `shared/constants.js` without changing them.
It saves a compressed `.blend` and disables numbered backup files.

The camera is centered at `(0, 0, 15)`, looks straight down world `-Z`, and uses an
orthographic scale of `11.2`. The platform radius is `5.0` world units. Display the
square PNG at `ARENA.platformRadius * 2 * (11.2 / 10)` logical pixels, centered on
`ARENA.centerX, ARENA.centerY`. With the current constants this is `560 × 560`,
placing the platform boundary at radius `250` while retaining room for its glow.

The PNG supplies only the platform art. Stars, particles, players, labels and
trails remain live Phaser rendering. The model contains no gameplay or physics.
