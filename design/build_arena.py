"""Build RUMBLE's editable arena model and its top-down Phaser texture.

Run with Blender 4.5 LTS:
  blender --background --python design/build_arena.py

All geometry, materials, lettering, lighting and glow are generated locally.
No downloaded models or textures are used. The JavaScript renderer remains 2D;
the editable .blend and .glb are source assets for future art iteration.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys

import bpy


def arguments():
    tail = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--render-output', type=Path,
                        default=Path(__file__).resolve().parent.parent / 'client' / 'src' / 'game' / 'assets')
    parser.add_argument('--samples', type=int, default=48)
    return parser.parse_args(tail)


def read_contract():
    source = (Path(__file__).resolve().parent.parent / 'shared' / 'constants.js').read_text()
    arena = re.search(r'export const ARENA = Object.freeze\(\{(.*?)\}\)', source, re.S).group(1)
    theme = re.search(r'export const THEME = Object.freeze\(\{(.*?)\}\)', source, re.S).group(1)
    values = {name: float(re.search(rf'\b{name}:\s*([\d.]+)', arena).group(1))
              for name in ('width', 'height', 'centerX', 'centerY', 'platformRadius')}
    colors = {name: re.search(rf"\b{name}:\s*'([^']+)'", theme).group(1)
              for name in ('background', 'arena', 'primary')}
    return values, colors


def linear_channel(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def rgba(hex_color):
    channels = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return (*[linear_channel(channel) for channel in channels], 1)


def material(name, color, *, metallic=0, roughness=0.5, emission=0):
    result = bpy.data.materials.new(name)
    result.diffuse_color = rgba(color)
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = rgba(color)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Emission Color'].default_value = rgba(color)
    shader.inputs['Emission Strength'].default_value = emission
    return result


MODEL_OBJECTS = []
MODEL_COLLECTION = None


def track(obj, name, mat):
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    for collection in list(obj.users_collection):
        collection.objects.unlink(obj)
    MODEL_COLLECTION.objects.link(obj)
    MODEL_OBJECTS.append(obj)
    return obj


def bevel(obj, amount=0.035):
    modifier = obj.modifiers.new('Machined edge bevel', 'BEVEL')
    modifier.width = amount
    modifier.segments = 3
    normals = obj.modifiers.new('Weighted surface normals', 'WEIGHTED_NORMAL')
    normals.keep_sharp = True
    return obj


def cylinder(name, radius, depth, z, mat, bevel_size=0.025):
    bpy.ops.mesh.primitive_cylinder_add(vertices=192, radius=radius, depth=depth, location=(0, 0, z))
    obj = track(bpy.context.object, name, mat)
    return bevel(obj, bevel_size) if bevel_size else obj


def ring(name, radius, tube, z, mat):
    bpy.ops.mesh.primitive_torus_add(major_segments=192, minor_segments=10,
                                    location=(0, 0, z), major_radius=radius, minor_radius=tube)
    obj = track(bpy.context.object, name, mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def band(name, inner, outer, z, depth, mat):
    vertices, faces = [], []
    count = 192
    for height, radius in ((z + depth / 2, outer), (z + depth / 2, inner),
                           (z - depth / 2, outer), (z - depth / 2, inner)):
        vertices.extend((radius * math.cos(index * 2 * math.pi / count),
                         radius * math.sin(index * 2 * math.pi / count), height)
                        for index in range(count))
    for index in range(count):
        following = (index + 1) % count
        faces += [(index, following, count + following, count + index),
                  (index, 2 * count + index, 2 * count + following, following),
                  (count + index, count + following, 3 * count + following, 3 * count + index),
                  (2 * count + index, 3 * count + index, 3 * count + following, 2 * count + following)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return bevel(track(obj, name, mat), min(depth / 3, 0.012))


def box(name, x, y, z, length, width, depth, angle, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z), rotation=(0, 0, angle))
    obj = bpy.context.object
    obj.dimensions = (length, width, depth)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return bevel(track(obj, name, mat), min(width / 3, 0.014))


def arc(name, radius, start, finish, width, z, mat):
    points = max(6, int((finish - start) * 64))
    vertices, faces = [], []
    for index in range(points + 1):
        angle = start + (finish - start) * index / points
        for distance in (radius - width / 2, radius + width / 2):
            vertices.append((distance * math.cos(angle), distance * math.sin(angle), z))
    for index in range(points):
        faces.append((index * 2, index * 2 + 1, index * 2 + 3, index * 2 + 2))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return track(obj, name, mat)


def lettering(name, text, y, size, mat):
    bpy.ops.object.text_add(location=(0, y, 0.079))
    obj = bpy.context.object
    obj.data.body = text
    obj.data.align_x = 'CENTER'
    obj.data.align_y = 'CENTER'
    obj.data.size = size
    obj.data.space_character = 1.2
    obj.data.extrude = 0.001
    obj.data.bevel_depth = 0.0005
    obj = track(obj, name, mat)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    return obj


def light(name, location, color, energy, size):
    data = bpy.data.lights.new(name, 'AREA')
    data.color = tuple(rgba(color)[:3])
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    # Area lights face local -Z, matching the perfectly overhead camera.
    return obj


def compositor(scene):
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    layers = tree.nodes.new('CompositorNodeRLayers')
    layers.location = (-600, 80)
    glow = tree.nodes.new('CompositorNodeGlare')
    glow.name = 'Soft neon halo'
    glow.glare_type = 'FOG_GLOW'
    glow.quality = 'HIGH'
    glow.threshold = 0.8
    glow.size = 8
    glow.mix = 0
    glow.location = (-380, 80)
    tree.links.new(layers.outputs['Image'], glow.inputs['Image'])
    # Preserve glow beyond the model's silhouette in the transparent PNG.
    channels = tree.nodes.new('CompositorNodeSepRGBA')
    tree.links.new(glow.outputs['Image'], channels.inputs['Image'])
    maximum_rg = tree.nodes.new('CompositorNodeMath')
    maximum_rg.operation = 'MAXIMUM'
    tree.links.new(channels.outputs['R'], maximum_rg.inputs[0])
    tree.links.new(channels.outputs['G'], maximum_rg.inputs[1])
    maximum_rgb = tree.nodes.new('CompositorNodeMath')
    maximum_rgb.operation = 'MAXIMUM'
    tree.links.new(maximum_rg.outputs[0], maximum_rgb.inputs[0])
    tree.links.new(channels.outputs['B'], maximum_rgb.inputs[1])
    alpha = tree.nodes.new('CompositorNodeMath')
    alpha.operation = 'MAXIMUM'
    alpha.use_clamp = True
    tree.links.new(maximum_rgb.outputs[0], alpha.inputs[0])
    tree.links.new(layers.outputs['Alpha'], alpha.inputs[1])
    set_alpha = tree.nodes.new('CompositorNodeSetAlpha')
    set_alpha.mode = 'REPLACE_ALPHA'
    set_alpha.location = (-80, 80)
    tree.links.new(glow.outputs['Image'], set_alpha.inputs['Image'])
    tree.links.new(alpha.outputs[0], set_alpha.inputs['Alpha'])
    output = tree.nodes.new('CompositorNodeComposite')
    output.location = (160, 80)
    tree.links.new(set_alpha.outputs['Image'], output.inputs['Image'])


def main():
    global MODEL_COLLECTION
    options = arguments()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    render_output = options.render_output.resolve()
    render_output.mkdir(parents=True, exist_ok=True)
    arena, theme = read_contract()
    bpy.context.preferences.filepaths.save_version = 0
    bpy.context.preferences.filepaths.use_file_compression = True
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)
    MODEL_COLLECTION = bpy.data.collections.new('RUMBLE — editable arena')
    bpy.context.scene.collection.children.link(MODEL_COLLECTION)

    deck = material('Deck / shared THEME.arena', theme['arena'], metallic=0.22, roughness=0.58, emission=0.16)
    frame = material('Frame / anodized midnight metal', '#111427', metallic=0.7, roughness=0.32)
    panels = material('Inset rim panels', '#1D2342', metallic=0.48, roughness=0.4)
    underside = material('Underside purple alloy', '#251A43', metallic=0.6, roughness=0.4)
    purple = material('Neon / shared THEME.primary', theme['primary'], roughness=0.3, emission=4.0)
    dim_purple = material('Concentric guide lines', '#68518D', roughness=0.5, emission=0.32)
    cyan = material('Cyan accent lights', '#22D3EE', roughness=0.3, emission=2.4)
    pink = material('Pink accent lights', '#F472B6', roughness=0.3, emission=2.4)
    metal = material('Bolt heads / brushed titanium', '#59617B', metallic=0.8, roughness=0.34)
    lettering_mat = material('Deck typography / muted lavender', '#55536E', roughness=0.6, emission=0.1)

    cylinder('Main chassis', 4.99, 0.38, -0.24, frame, 0.08)
    cylinder('Lower floating tier', 4.8, 0.12, -0.47, underside, 0.045)
    ring('Underside purple light strip', 4.77, 0.022, -0.405, purple)
    cylinder('Playable deck', 4.83, 0.1, 0.016, deck, 0.025)
    band('Raised outer rim', 4.78, 5.0, 0.08, 0.075, frame)
    ring('Primary neon rim / radius 5.0 boundary', 4.96, 0.024, 0.126, purple)
    ring('Inner lip accent', 4.79, 0.008, 0.126, dim_purple)
    ring('Outer lower accent', 4.98, 0.009, -0.03, purple)
    for index, radius in enumerate((1.24, 2.48, 3.72)):
        ring(f'Concentric deck guide {index + 1}', radius, 0.0075, 0.073, dim_purple)
    ring('Outer deck guide', 4.62, 0.006, 0.073, dim_purple)

    for index in range(64):
        angle = index / 64 * math.tau
        length = 0.155 if index % 4 == 0 else 0.065
        radius = 4.55 - length / 2
        box(f'Calibration tick {index + 1:02}', radius * math.cos(angle), radius * math.sin(angle), 0.076,
            length, 0.015 if index % 4 else 0.022, 0.006, angle, dim_purple)
    for index in range(16):
        angle = index / 16 * math.tau
        radius = 4.865
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.027, depth=0.013,
                                            location=(radius * math.cos(angle), radius * math.sin(angle), 0.129))
        track(bpy.context.object, f'Rim fastener {index + 1:02}', metal)
    for index in range(8):
        angle = index / 8 * math.tau
        radius = 4.27
        box(f'Outer deck radial inset {index + 1}', radius * math.cos(angle), radius * math.sin(angle), 0.071,
            0.44, 0.1, 0.006, angle, panels)
        arc(f'Neon rim accent {index + 1}', 4.96, angle - 0.028, angle + 0.028,
            0.045, 0.153, cyan if index % 2 == 0 else pink)
        # A short bright slot sits inward of each edge anchor.
        radius = 4.31
        box(f'Anchor light {index + 1}', radius * math.cos(angle), radius * math.sin(angle), 0.081,
            0.115, 0.026, 0.008, angle, cyan if index % 2 == 0 else pink)

    box('Center reticle / horizontal', 0, 0, 0.075, 0.29, 0.012, 0.004, 0, dim_purple)
    box('Center reticle / vertical', 0, 0, 0.075, 0.29, 0.012, 0.004, math.pi / 2, dim_purple)
    lettering('RUMBLE deck wordmark', 'R U M B L E', -0.48, 0.18, lettering_mat)
    lettering('Arena identification', 'A R E N A  /  0 1', -0.73, 0.075, lettering_mat)

    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new('RUMBLE dark studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = rgba(theme['background'])
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4
    light('Overhead softbox', (0, 0, 10), '#DFE5FF', 1100, 9)
    light('Cyan softbox', (-4, 2, 7), '#6ADAF5', 160, 7)
    light('Purple softbox', (4, -2, 7), '#BF85FF', 200, 7)
    camera_data = bpy.data.cameras.new('Perfect top-down orthographic camera')
    camera = bpy.data.objects.new('Arena texture camera', camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0, 0, 15)
    camera.rotation_euler = (0, 0, 0)
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = 11.2
    scene.camera = camera

    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = options.samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'Medium High Contrast'
    scene.view_settings.exposure = -0.25
    scene.view_settings.gamma = 1
    compositor(scene)
    scene.render.filepath = str(render_output / 'arena-platform.png')
    scene['source_of_truth'] = 'shared/constants.js'
    scene['logical_platform_radius'] = arena['platformRadius']
    scene['png_display_size'] = arena['platformRadius'] * 2 * (11.2 / 10)
    scene['texture_note'] = 'Top-down, centered, transparent RGBA. Display centered at ARENA.centerX/centerY.'

    bpy.ops.object.select_all(action='DESELECT')
    for obj in MODEL_OBJECTS:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = MODEL_OBJECTS[0]
    bpy.ops.export_scene.gltf(filepath=str(output / 'arena.glb'), export_format='GLB', use_selection=True,
                              export_apply=True, export_materials='EXPORT', export_cameras=False, export_lights=False)
    # Save an editable camera view; all individual geometry objects remain separate.
    bpy.ops.object.select_all(action='DESELECT')
    bpy.data.objects['Playable deck'].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects['Playable deck']
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_perspective = 'CAMERA'
                area.spaces.active.shading.type = 'MATERIAL'
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'arena.blend'), compress=True)
    bpy.ops.render.render(write_still=True)
    metadata = {
        'generator': 'design/build_arena.py',
        'blender_version': bpy.app.version_string,
        'render_size': [1024, 1024],
        'transparent': True,
        'projection': 'orthographic top-down',
        'orthographic_scale': 11.2,
        'platform_radius_world': 5.0,
        'platform_radius_logical': arena['platformRadius'],
        'display_size_logical': arena['platformRadius'] * 2 * (11.2 / 10),
        'display_center_logical': [arena['centerX'], arena['centerY']],
        'generated_objects': len(MODEL_OBJECTS),
        'files': ['arena-platform.png'],
        'design_source': 'design/arena.blend',
        'model_export': 'design/arena.glb',
        'textures': 'None: all geometry and materials are procedural.',
    }
    (render_output / 'arena-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print('RUMBLE arena build complete:', output)


if __name__ == '__main__':
    main()
