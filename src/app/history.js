// Undo / redo (plan §12.5): a list of settings snapshots. Each setting change is one step; the
// changes of one path that come fast (a slider drag) join into one step.

const JOIN_MS = 600;

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.past = []; // snapshots (JSON) before each step
    this.future = [];
    this.last = null; // { path, time } of the last step
  }

  // Call before a change. path: the setting path (or a name like 'preset', 'randomize').
  record(snapshot, path, now = Date.now()) {
    const join = this.last && path && this.last.path === path && now - this.last.time < JOIN_MS;
    this.last = { path, time: now };
    if (join) return false;
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }

  // The end of a drag: the next change is a new step.
  cut() {
    this.last = null;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  // current: the snapshot now. Returns the snapshot to restore, or null.
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(current);
    this.last = null;
    return this.past.pop();
  }

  redo(current) {
    if (!this.future.length) return null;
    this.past.push(current);
    this.last = null;
    return this.future.pop();
  }
}
