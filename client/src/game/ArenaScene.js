import Phaser from 'phaser';
import { ARENA, PLAYER_COLORS, THEME } from '@rumble/shared/constants';
import platformTextureUrl from './assets/arena-platform.png';
import platformModel from './assets/arena-metadata.json';

const hexNumber = (hex) => Number.parseInt(hex.slice(1), 16);
const TRAIL_LIFETIME = 520;
const PLATFORM_TEXTURE = 'rumble-blender-platform';

export default class ArenaScene extends Phaser.Scene {
  constructor({ reducedMotion = false, onReady } = {}) {
    super({ key: 'ArenaScene' });
    this.reducedMotion = reducedMotion;
    this.onReady = onReady;
    this.pendingSnapshot = { players: [] };
    this.playerViews = new Map();
    this.ready = false;
  }

  preload() {
    if (!this.textures.exists(PLATFORM_TEXTURE)) {
      this.load.image(PLATFORM_TEXTURE, platformTextureUrl);
    }
  }

  create() {
    this.cameras.main.setBackgroundColor(THEME.background);
    const random = new Phaser.Math.RandomDataGenerator(['rumble-arena']);
    this.stars = Array.from({ length: 80 }, () => ({
      x: random.between(10, ARENA.width - 10), y: random.between(10, ARENA.height - 10),
      radius: random.realInRange(0.6, 1.5), phase: random.realInRange(0, Math.PI * 2),
    }));
    this.drifters = Array.from({ length: 20 }, () => ({
      x: random.between(0, ARENA.width), y: random.between(0, ARENA.height),
      speed: random.realInRange(3, 10), phase: random.realInRange(0, Math.PI * 2),
      color: [0xa855f7, 0x22d3ee, 0xf472b6][random.between(0, 2)],
    }));
    this.starGraphics = this.add.graphics().setDepth(0);
    this.drawPlatform();
    this.particleGraphics = this.add.graphics().setDepth(2);
    this.trailGraphics = this.add.graphics().setDepth(3);
    this.ready = true;
    this.setState(this.pendingSnapshot);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.releaseViews, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.releaseViews, this);
    this.onReady?.();
  }

  drawPlatform() {
    if (this.textures.exists(PLATFORM_TEXTURE)) {
      // Match the model's world-space boundary to the shared logical arena radius.
      // The orthographic frame includes transparent padding for the neon glow.
      const size = ARENA.platformRadius * platformModel.orthographic_scale / platformModel.platform_radius_world;
      this.add.image(ARENA.centerX, ARENA.centerY, PLATFORM_TEXTURE).setDisplaySize(size, size).setDepth(1);
    } else {
      this.drawFallbackPlatform();
    }
    this.add.text(ARENA.centerX, ARENA.centerY + ARENA.platformRadius + 27, 'THE ARENA / RUMBLE', {
      fontFamily: 'Avenir Next, Arial, sans-serif', fontSize: '10px', color: '#64748b', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(1);
  }

  drawFallbackPlatform() {
    const { centerX: x, centerY: y, platformRadius: radius } = ARENA;
    const graphics = this.add.graphics().setDepth(1);
    graphics.fillStyle(0x050713, 0.7).fillEllipse(x, y + 26, radius * 2 + 42, radius * 2);
    graphics.fillStyle(hexNumber(THEME.arena), 1).fillCircle(x, y, radius);
    for (const [width, alpha] of [[30, 0.025], [18, 0.06], [9, 0.13], [3, 0.9]]) {
      graphics.lineStyle(width, hexNumber(THEME.primary), alpha).strokeCircle(x, y, radius);
    }
    for (const scale of [0.25, 0.5, 0.75, 0.94]) {
      graphics.lineStyle(1, 0xa855f7, scale === 0.94 ? 0.24 : 0.16).strokeCircle(x, y, radius * scale);
    }
    for (let index = 0; index < 48; index++) {
      const angle = index / 48 * Math.PI * 2;
      const outer = radius - 10;
      const inner = outer - (index % 4 === 0 ? 9 : 4);
      graphics.lineStyle(1, 0xc084fc, index % 4 === 0 ? 0.55 : 0.2);
      graphics.lineBetween(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner, x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    }
    graphics.lineStyle(1, 0xc084fc, 0.25).lineBetween(x - 12, y, x + 12, y).lineBetween(x, y - 12, x, y + 12);
  }

  /**
   * Renderer view model: { players: [{ id, x, y, name, colorIndex, alive?, connected? }] }.
   * In M4, combine game positions with RoomSnapshot player names/colors before calling.
   * No network events are consumed, and the supplied snapshot is never mutated.
   */
  setState(snapshot) {
    if (!Array.isArray(snapshot?.players)) return;
    this.pendingSnapshot = snapshot;
    if (!this.ready) return;
    const present = new Set();
    for (const player of snapshot.players) {
      if (typeof player.id !== 'string' || !Number.isFinite(player.x) || !Number.isFinite(player.y)) continue;
      present.add(player.id);
      let view = this.playerViews.get(player.id);
      if (!view) {
        const halo = this.add.circle(0, 0, 29, 0xffffff, 0.045);
        const glow = this.add.circle(0, 0, 22, 0xffffff, 0.1);
        const body = this.add.circle(0, 0, 14, 0xffffff).setStrokeStyle(2, 0xffffff, 0.65);
        const shine = this.add.circle(-4, -4, 4, 0xffffff, 0.45);
        const label = this.add.text(0, -37, '', { fontFamily: 'Avenir Next, Arial, sans-serif', fontSize: '15px', fontStyle: 'bold', color: '#f8fafc', stroke: '#090b1a', strokeThickness: 4 }).setOrigin(0.5);
        const container = this.add.container(player.x, player.y, [halo, glow, body, shine, label]).setDepth(4);
        view = { container, halo, glow, body, label, trail: [], lastTrailAt: 0 };
        this.playerViews.set(player.id, view);
      }
      const color = PLAYER_COLORS[player.colorIndex] ?? PLAYER_COLORS[0];
      view.color = hexNumber(color.hex);
      view.targetX = player.x;
      view.targetY = player.y;
      view.alive = player.alive !== false;
      view.halo.setFillStyle(view.color, 0.045);
      view.glow.setFillStyle(view.color, 0.1);
      view.body.setFillStyle(view.color, 1);
      view.label.setText(typeof player.name === 'string' ? player.name : 'Player');
      view.container.setAlpha(!view.alive ? 0.18 : player.connected === false ? 0.45 : 1);
    }
    for (const [id, view] of this.playerViews) {
      if (present.has(id)) continue;
      view.container.destroy();
      this.playerViews.delete(id);
    }
  }

  update(time, delta) {
    if (!this.ready) return;
    const seconds = this.reducedMotion ? 0 : time / 1000;
    this.starGraphics.clear();
    for (const star of this.stars) {
      const alpha = 0.18 + (Math.sin(seconds * 0.7 + star.phase) + 1) * 0.18;
      this.starGraphics.fillStyle(0xcbd5e1, alpha).fillCircle(star.x, star.y, star.radius);
    }
    this.particleGraphics.clear();
    for (const particle of this.drifters) {
      const x = (particle.x + seconds * particle.speed * 0.35) % ARENA.width;
      const y = ((particle.y - seconds * particle.speed) % ARENA.height + ARENA.height) % ARENA.height;
      this.particleGraphics.fillStyle(particle.color, 0.15 + Math.sin(seconds + particle.phase) * 0.07).fillCircle(x, y, 1.7);
    }
    this.trailGraphics.clear();
    const blend = this.reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 100) / 65);
    for (const view of this.playerViews.values()) {
      const { container } = view;
      const distance = Phaser.Math.Distance.Between(container.x, container.y, view.targetX, view.targetY);
      container.setPosition(Phaser.Math.Linear(container.x, view.targetX, blend), Phaser.Math.Linear(container.y, view.targetY, blend));
      if (!this.reducedMotion && view.alive && distance > 1 && time - view.lastTrailAt > 35) {
        view.trail.push({ x: container.x, y: container.y, time });
        view.lastTrailAt = time;
      }
      view.trail = view.trail.filter((point) => time - point.time < TRAIL_LIFETIME).slice(-16);
      for (const point of view.trail) {
        const remaining = 1 - (time - point.time) / TRAIL_LIFETIME;
        this.trailGraphics.fillStyle(view.color, remaining * 0.17).fillCircle(point.x, point.y, 4 + remaining * 9);
      }
    }
  }

  releaseViews() {
    this.ready = false;
    this.playerViews.clear();
    this.stars = [];
    this.drifters = [];
    this.pendingSnapshot = { players: [] };
  }
}
