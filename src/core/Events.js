// Tiny event bus. events.on('hit', fn); events.emit('hit', data)
export class Events {
  constructor() { this.map = new Map(); }
  on(name, fn) { (this.map.get(name) ?? this.map.set(name, new Set()).get(name)).add(fn); return () => this.off(name, fn); }
  off(name, fn) { this.map.get(name)?.delete(fn); }
  emit(name, data) { const s = this.map.get(name); if (s) for (const fn of s) fn(data); }
}
export const events = new Events();
