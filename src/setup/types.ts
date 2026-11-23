import type { Config } from '../config.ts';
import { broadcast } from '../bus.ts';

/**
 * 上手向导的契约。每个模块（tools / auth / workspace）各管几段，导出：
 *   sections(cfg) —— 这几段现在什么状态（向导每次刷新都调，要快，别在这里装东西）
 *   routes        —— 'POST /api/setup/xxx' → 处理函数。返回值原样 JSON 回给页面，抛错 = 500 { error }
 * 慢操作（下载、clone、装插件）立即返回 { started: true }，过程用 progress() 推到 SSE，结束时推 done。
 */

/** 向导里的固定顺序，页面也按这个排 */
export const SECTION_ORDER = ['tools', 'model', 'lark', 'workspace', 'plugin'] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

export interface Check {
  /** 段内唯一，如 'lark-cli' / 'mcp:plugin:my-skills:BAT' */
  id: string;
  label: string;
  state: 'ok' | 'missing' | 'error' | 'running';
  /** 版本号、报错、下一步提示……一行字 */
  detail?: string;
  /** 不影响「全部就绪」，比如 git 拉取失败的个别仓库 */
  optional?: boolean;
  /** 页面上按钮的字，点了 POST 到 action.route，带 action.body */
  action?: { label: string; route: string; body?: unknown };
}

export interface Section {
  id: SectionId;
  title: string;
  checks: Check[];
}

export type Handler = (body: any, ctx: { cfg: Config }) => Promise<unknown>;

export interface SetupModule {
  sections(cfg: Config): Promise<Section[]>;
  routes: Record<string, Handler>;
}

/** 推一条进度到所有打开的页面。done 表示这次操作结束了，ok 是成没成 */
export function progress(section: SectionId, msg: string, end?: { ok: boolean }): void {
  broadcast({ type: 'setup', section, msg, ...(end ? { done: true, ok: end.ok } : {}) });
}
