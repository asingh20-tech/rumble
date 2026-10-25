# RUMBLE arena design source

These authoring files stay outside the client source and build:

- `arena.blend`: editable, compressed Blender model with named geometry/materials.
- `arena.glb`: portable model export, without cameras or external textures.
- `build_arena.py`: procedural geometry, material, lighting, camera, and render generator.

From the `rumble` directory, with Blender 4.5 LTS installed:

```bash
blender --background --factory-startup --python design/build_arena.py
```

On macOS, use `/Applications/Blender.app/Contents/MacOS/Blender` if Blender is not
on PATH. Add `-- --samples 96` for a higher-sample render.

By default, editable `.blend`/`.glb` outputs stay in `design/`; the transparent
PNG and projection metadata go to `client/src/game/assets/`. Override these
with `--output` and `--render-output` respectively. The generator reads the
arena dimensions and theme from `shared/constants.js` without modifying it.
No external models or image textures are used.

The overhead orthographic camera uses scale 11.2 and a platform radius of 5 world
units. Phaser displays the PNG at
`ARENA.platformRadius * orthographic_scale / platform_radius_world`, centered
on the shared arena center. Only the PNG is loaded at runtime; player positions,
names, colors, connectivity, and trails remain live rendering.
