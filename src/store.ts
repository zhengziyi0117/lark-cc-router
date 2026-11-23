/**
 * 进程内并发闸。单进程所以不用文件信号量 —— 这是换 TS 之后白捡的一处简化。
 *
 * （以前这里还有个 Store 管每个会话的水位，改成一趟全局搜索之后就不需要了：
 *   "查到哪了"只有一个游标，存在 db 的 meta 表里。）
 */
export class Pool {
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    await new Promise<void>((r) => this.waiters.push(r));
  }

  /** 名额直接交给排队的（running 不变）；调小过上限、还超着的时候就不交，先降下来 */
  release(): void {
    const next = this.running <= this.max ? this.waiters.shift() : undefined;
    if (next) next();
    else this.running--;
  }

  /** web UI 改并发上限时热更新。调大立刻放排队的进来；调小不掐在跑的，等它们自然还名额 */
  resize(max: number): void {
    this.max = max;
    while (this.running < this.max && this.waiters.length) { this.running++; this.waiters.shift()!(); }
  }
}
