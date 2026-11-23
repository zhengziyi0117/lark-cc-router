import type { Config } from '../config.ts';
import { SECTION_ORDER, type Handler, type Section, type SectionId, type SetupModule } from './types.ts';
import * as tools from './tools.ts';
import * as auth from './auth.ts';
import * as workspace from './workspace.ts';
import { preset } from './preset.ts';

/** 模块 → 它挂了的时候报错显示在哪一段 */
const MODULES: [SetupModule, SectionId][] = [[tools, 'tools'], [auth, 'model'], [workspace, 'workspace']];

/** 全部段的状态，按向导顺序。某个模块自己挂了不拖累别的：那一段显示成 error */
export async function status(cfg: Config): Promise<{ ready: boolean; todo: boolean; sections: Section[] }> {
  const parts = await Promise.all(MODULES.map(([m, id]) => m.sections(cfg).catch((e: any): Section[] => [{
    id, title: '检测失败', checks: [{ id: 'error', label: '检测失败', state: 'error', detail: e.message }],
  }])));
  const sections = parts.flat().sort((a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id));
  const ready = sections.length > 0 && sections.every((s) => s.checks.every((c) => c.optional || c.state === 'ok'));
  // 还要用户动手的：明确缺了或者报错。「检测中」不算 —— 刚启动时网关、MCP 都还在后台测，
  // 拿 ready 决定开哪页的话每次启动都会掉进向导，看着像配置没存住
  const todo = !sections.length || sections.some((s) => s.checks.some((c) => !c.optional && (c.state === 'missing' || c.state === 'error')));
  return { ready, todo, sections };
}

/** 团队预置给页面当默认值。应用 secret 不下发，只说有没有 */
const presetRoute: Handler = async () => {
  const p = preset();
  return { ...p, larkApp: { appId: p.larkApp.appId, hasSecret: !!p.larkApp.appSecret } };
};

/** 'POST /api/setup/xxx' → 处理函数 */
export function route(method: string, path: string): Handler | undefined {
  const key = `${method} ${path}`;
  if (key === 'GET /api/setup/preset') return presetRoute;
  for (const [m] of MODULES) if (m.routes[key]) return m.routes[key];
  return undefined;
}
