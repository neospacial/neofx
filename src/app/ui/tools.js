// Preview tools (plan §9.1, §12.1): the eyedropper (chroma key colour) and the garbage matte brush
// (Always subject / Never subject / Erase). One finger or the mouse: the active tool.

export class PreviewTools {
  // app: { pick(u, v), stroke(points, mode), brush: { size, hardness }, onTool(tool) }
  constructor(area, canvas, app) {
    this.area = area;
    this.canvas = canvas;
    this.app = app;
    this.tool = null; // null | 'pick' | 'always' | 'never' | 'erase'
    this.cursor = document.createElement('div');
    this.cursor.className = 'brushCursor';
    this.cursor.hidden = true;
    area.append(this.cursor);
    this.bind(canvas);
  }

  // The listeners on the preview canvas (again when the canvas is new: a GPU restart).
  bind(canvas) {
    this.canvas = canvas;
    let pts = null, sent = 0, raf = 0;
    const uv = (e) => {
      const b = canvas.getBoundingClientRect();
      return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
    };
    // Send the new points of the stroke (with the last sent point, so the stroke is continuous).
    const flush = () => {
      raf = 0;
      if (!pts || pts.length <= sent) return;
      const part = pts.slice(Math.max(0, sent - 1));
      sent = pts.length;
      this.app.stroke(part, this.tool);
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.tool || e.button > 0) return;
      e.preventDefault();
      if (this.tool === 'pick') {
        this.app.pick(...uv(e));
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      pts = [uv(e)];
      sent = 0;
      flush();
    });
    canvas.addEventListener('pointermove', (e) => {
      this.moveCursor(e);
      if (!pts) return;
      pts.push(uv(e));
      if (!raf) raf = requestAnimationFrame(flush);
    });
    const end = () => {
      if (pts) flush();
      pts = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => (this.cursor.hidden = true));
    canvas.style.cursor = this.tool === 'pick' ? 'crosshair' : this.tool ? 'none' : '';
  }

  setTool(tool) {
    this.tool = this.tool === tool ? null : tool;
    this.canvas.style.cursor = this.tool === 'pick' ? 'crosshair' : this.tool ? 'none' : '';
    this.cursor.hidden = true;
    this.app.onTool(this.tool);
  }

  moveCursor(e) {
    const brush = this.tool && this.tool !== 'pick';
    this.cursor.hidden = !brush;
    if (!brush) return;
    const b = this.canvas.getBoundingClientRect(), a = this.area.getBoundingClientRect();
    const d = (this.app.brush.size * b.width) / this.canvas.width;
    Object.assign(this.cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - a.left - d / 2}px`, top: `${e.clientY - a.top - d / 2}px` });
  }
}
