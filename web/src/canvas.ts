type Node = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Edge = {
  s: number;
  d: number;
};

export class CanvasGraph {
  private readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D;

  private readonly nodes: Map<number, Node> = new Map();

  private edges: Edge[] = [];

  private scale = 1;

  private tx = 0;

  private ty = 0;

  private dragging = false;

  private lastX = 0;

  private lastY = 0;

  private lastFrame = performance.now();

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Unable to acquire 2D context");
    this.ctx = context;
    parent.appendChild(this.canvas);

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(parent);
    this.resize();

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        const factor = event.deltaY < 0 ? 1.1 : 0.9;
        const rect = this.canvas.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        this.tx = cx - factor * (cx - this.tx);
        this.ty = cy - factor * (cy - this.ty);
        this.scale *= factor;
        event.preventDefault();
      },
      { passive: false },
    );

    this.canvas.addEventListener("mousedown", (event) => {
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    });

    window.addEventListener("mousemove", (event) => {
      if (!this.dragging) return;
      this.tx += event.clientX - this.lastX;
      this.ty += event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    });

    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });

    requestAnimationFrame(() => this.frame());
  }

  setSnapshot(
    nodes: Array<{ asn: number }>,
    edges: Array<{ src_as: number; dst_as: number }>,
  ): void {
    const total = nodes.length;
    nodes.forEach((node, index) => {
      if (!this.nodes.has(node.asn)) {
        const angle = (2 * Math.PI * index) / Math.max(1, total);
        this.nodes.set(node.asn, {
          id: node.asn,
          x: 300 * Math.cos(angle),
          y: 300 * Math.sin(angle),
          vx: 0,
          vy: 0,
        });
      }
    });
    this.edges = edges.map((edge) => ({ s: edge.src_as, d: edge.dst_as }));
  }

  applyAnnounce(origin_as: number | null, as_path?: string): void {
    if (!as_path) return;
    const parts = as_path
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value));
    parts.forEach((asn) => {
      if (!this.nodes.has(asn)) {
        this.nodes.set(asn, {
          id: asn,
          x: (Math.random() - 0.5) * 600,
          y: (Math.random() - 0.5) * 600,
          vx: 0,
          vy: 0,
        });
      }
    });
    for (let i = 0; i < parts.length - 1; i += 1) {
      this.edges.push({ s: parts[i], d: parts[i + 1] });
    }
    if (origin_as && !this.nodes.has(origin_as)) {
      this.nodes.set(origin_as, {
        id: origin_as,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      });
    }
  }

  private resize(): void {
    this.canvas.width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800;
    this.canvas.height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 600;
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.simulate(dt);
    this.draw();
    requestAnimationFrame(() => this.frame());
  }

  private simulate(dt: number): void {
    const spring = 0.02;
    const repulsion = 5000;
    const entries = Array.from(this.nodes.values());

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 0.01;
        const force = repulsion / distSq;
        const factor = force / Math.sqrt(distSq);
        a.vx -= factor * dx * dt;
        a.vy -= factor * dy * dt;
        b.vx += factor * dx * dt;
        b.vy += factor * dy * dt;
      }
    }

    for (const edge of this.edges) {
      const source = this.nodes.get(edge.s);
      const target = this.nodes.get(edge.d);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      source.vx += spring * dx * dt;
      source.vy += spring * dy * dt;
      target.vx -= spring * dx * dt;
      target.vy -= spring * dy * dt;
    }

    for (const node of entries) {
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.9;
      node.vy *= 0.9;
    }
  }

  private draw(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 / this.scale;
    ctx.strokeStyle = "#3b82f6";
    for (const edge of this.edges) {
      const source = this.nodes.get(edge.s);
      const target = this.nodes.get(edge.d);
      if (!source || !target) continue;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e5e7eb";
    for (const node of this.nodes.values()) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, Math.max(2, 4 / this.scale), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
