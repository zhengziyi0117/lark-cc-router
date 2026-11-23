import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.ts';

/**
 * 团队预置：共享飞书应用、网关地址、常用工作区和插件。跟着安装包走（desktop/preset.json），
 * 向导拿它当默认值 —— 产品同学不用知道这些地址，点「用推荐的」就行。读不到就是全空，向导让用户自己填。
 */
export interface Preset {
  larkApp: { appId: string; appSecret: string };
  larkScopes: string;
  gateway: { baseUrl: string; consoleUrl: string; model: string };
  gitHosts: string[];
  gitTokenUrl: string;
  workspaces: { name: string; url: string; note?: string }[];
  plugins: { marketplace: string; plugin: string; note?: string }[];
}

const EMPTY: Preset = {
  larkApp: { appId: '', appSecret: '' }, larkScopes: '', gateway: { baseUrl: '', consoleUrl: '', model: '' },
  gitHosts: [], gitTokenUrl: '', workspaces: [], plugins: [],
};

export function preset(): Preset {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(resolve(ROOT, 'desktop/preset.json'), 'utf8')) }; } catch { return EMPTY; }
}
