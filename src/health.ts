import type { AgentEvent } from './agent.ts';

/**
 * CC 环境健康：每次跑 claude 时 init 事件会报它连上了哪些 MCP、加载了哪些 plugin。
 * OAuth 过期 / plugin 被关的时候 claude **不报错、照常跑**，只是少了那批工具 —— 模型回一句
 * "查不到"，谁也不知道是环境坏了。所以拿这次的跟上次的比，变了就说出来。
 */
export interface Health {
  /** server → 状态 */
  mcp: Record<string, string>;
  plugins: string[];
}

export function healthOf(e: Extract<AgentEvent, { kind: 'init' }>): Health | undefined {
  if (!e.mcp && !e.plugins) return undefined; // 老版本 claude 不报这些，别当成"全没了"
  return {
    mcp: Object.fromEntries((e.mcp ?? []).map((s) => [s.name, s.status])),
    plugins: [...(e.plugins ?? [])].sort(),
  };
}

const ok = (s: string | undefined) => s === 'connected';
/**
 * init 发出来那一刻还在连的。实测同一个环境连跑两次，一次 9 个全 connected、一次 6 个 pending ——
 * 纯属赛跑，不代表有问题。所以 pending 当"不知道"：不报，基线沿用上次的（见 withPending）。
 */
const PENDING = 'pending';

/** 存基线前用：这次还在 pending 的，沿用上次已知的状态，别让一次赛跑把基线洗成 pending */
export function withPending(prev: Health | undefined, cur: Health): Health {
  const mcp = { ...cur.mcp };
  for (const [n, s] of Object.entries(mcp)) {
    const was = prev?.mcp[n];
    if (s === PENDING && was && was !== PENDING) mcp[n] = was;
  }
  return { ...cur, mcp };
}

/**
 * 两次之间变了什么，一条一行。没有上次（第一次跑 / 换了项目）就只报现在坏着的，不把全部当"新增"刷一遍。
 * plugin 被关时它带的 MCP（`plugin:<名字>:xxx`）一起消失 —— 只报 plugin 那一条，不重复刷。
 */
export function healthDiff(prev: Health | undefined, cur: Health): string[] {
  const out: string[] = [];
  if (!prev) {
    for (const [n, s] of Object.entries(cur.mcp)) if (!ok(s) && s !== PENDING) out.push(`⚠️ MCP ${n}：${s}`);
    return out;
  }
  const gone = prev.plugins.filter((p) => !cur.plugins.includes(p));
  const added = cur.plugins.filter((p) => !prev.plugins.includes(p));
  const ownedBy = (server: string, plugins: string[]) => plugins.some((p) => server.startsWith(`plugin:${p}:`));

  for (const p of gone) out.push(`⚠️ plugin ${p}：不见了（被关了 / 卸了？）`);
  for (const p of added) out.push(`✅ plugin ${p}：新加载`);
  for (const [n, s] of Object.entries(cur.mcp)) {
    if (s === PENDING) continue;
    const was = prev.mcp[n];
    if (was === PENDING) { if (!ok(s)) out.push(`⚠️ MCP ${n}：${s}`); } // 之前一直不知道，现在知道是坏的
    else if (was === undefined) { if (!ownedBy(n, added)) out.push(`${ok(s) ? '✅' : '⚠️'} MCP ${n}：新出现（${s}）`); }
    else if (ok(was) && !ok(s)) out.push(`⚠️ MCP ${n}：${was} → ${s}`);
    else if (!ok(was) && ok(s)) out.push(`✅ MCP ${n}：恢复（${was} → ${s}）`);
    else if (was !== s) out.push(`⚠️ MCP ${n}：${was} → ${s}`);
  }
  for (const n of Object.keys(prev.mcp)) {
    if (!(n in cur.mcp) && !ownedBy(n, gone)) out.push(`⚠️ MCP ${n}：不见了`);
  }
  return out;
}
