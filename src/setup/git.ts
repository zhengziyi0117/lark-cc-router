import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME_DIR } from '../config.ts';
import { WIN } from '../bins.ts';

/**
 * GitLab 个人 token，按 host 存。产品同学没有 SSH key，所以有 token 的 host 一律走 HTTPS：
 *   - `git@host:group/repo.git` 自动改写成 `https://host/group/repo.git`（子模块、插件 marketplace 都是 SSH 地址）
 *   - token 用 http.extraHeader 带上 —— 不写进 .git/config，不出现在命令行参数里（ps 看得到）
 * 都通过 GIT_CONFIG_COUNT 这组环境变量传给 git（git ≥ 2.31），子模块 clone 和 claude 起的 git 都继承得到。
 * 没 token 的 host 原样走 SSH：开发同学本来就配好了。
 */
export const CRED_PATH = join(HOME_DIR, 'git-credentials.json');

export function gitTokens(path = CRED_PATH): Record<string, string> {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function setGitToken(host: string, token: string, path = CRED_PATH): void {
  const all = gitTokens(path);
  if (token) all[host] = token; else delete all[host];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2));
  chmodSync(path, 0o600);
}

/** 给 git 子进程的环境变量。叠在 process.env 上用：spawn(git, args, { env: { ...process.env, ...gitEnv() } }) */
export function gitEnv(tokens = gitTokens(), win = WIN): Record<string, string> {
  // Windows 的 git 默认用自带的 OpenSSL 证书包，不认内网 GitLab 的证书（公司自签的根证书），
  // 报 SSL certificate problem: unable to get local issuer certificate。schannel 走 Windows 证书库，公司根证书在里面
  const pairs: [string, string][] = win ? [['http.sslBackend', 'schannel']] : [];
  for (const [host, token] of Object.entries(tokens)) {
    pairs.push([`url.https://${host}/.insteadOf`, `git@${host}:`]);
    pairs.push([`url.https://${host}/.insteadOf`, `ssh://git@${host}/`]);
    // GitLab 的 token 走 Basic，用户名随便填一个非空的
    pairs.push([`http.https://${host}/.extraHeader`, `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`]);
  }
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (!pairs.length) return env;
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}
