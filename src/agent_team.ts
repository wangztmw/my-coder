/**
 * Team 注册表 — Agent / 后台 Bash 的共享状态管理 + 磁盘持久化
 *
 * 主 Agent / 子 Agent / 后台 Bash 三方通过此模块读写成员状态。
 * 输出原子写入磁盘（tmp + rename），内存只存摘要。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type MemberStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';

export interface MemberState {
  id: string;
  type: 'local_agent' | 'local_bash';
  status: MemberStatus;
  subject: string;
  description?: string;
  startTime: number;
  endTime?: number;
  output?: string;           // 内存摘要（前 500 字），完整内容在磁盘
  outputFile: string;        // ~/.mycoder/team/{id}.txt
  outputOffset: number;      // 当前写入偏移量（增量追加）
  notified: boolean;         // 完成通知是否已发送（防重复）
  toolUseId?: string;        // LLM 工具调用 id，可追溯到创建时机
  feedback?: string;         // 子Agent 主动反馈（双向通信）
  feedbackAt?: number;       // 反馈时间戳
  abortController?: AbortController;
  agentLoop?: {
    roundCount: number;
    toolUseCount: number;
    lastActivity?: string;
    lastOutput?: string;
  };
  pendingInstruction?: string;
}

const TEAM_DIR = join(homedir(), '.mycoder', 'team');
const team = new Map<string, MemberState>();

function ensureDir() {
  if (!existsSync(TEAM_DIR)) mkdirSync(TEAM_DIR, { recursive: true });
}

function memberOutputPath(id: string): string {
  return join(TEAM_DIR, `${id}.txt`);
}

/** 原子写磁盘：先写 tmp 再 rename，防止写一半崩溃留下损坏文件 */
export function saveMemberOutput(id: string, text: string): void {
  ensureDir();
  const path = memberOutputPath(id);
  const tmp = path + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** 读取完整磁盘输出 */
export function readMemberOutput(id: string): string {
  try { return readFileSync(memberOutputPath(id), 'utf-8'); } catch { return ''; }
}

/** 启动时清理 7 天前旧文件 */
export function cleanOldMembers(): void {
  try {
    if (!existsSync(TEAM_DIR)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(TEAM_DIR)) {
      const p = join(TEAM_DIR, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* 静默 */ }
}

export function addMember(type: 'local_agent' | 'local_bash', subject: string, desc?: string): MemberState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const member: MemberState = {
    id, type, status: 'pending', subject,
    description: desc,
    startTime: Date.now(),
    outputFile: memberOutputPath(id),
    outputOffset: 0,
    notified: false,
    abortController: new AbortController(),
  };
  if (type === 'local_agent') member.agentLoop = { roundCount: 0, toolUseCount: 0 };
  team.set(id, member);
  return member;
}

export function completeMember(id: string, output: string) {
  const m = team.get(id);
  if (m) {
    m.status = 'completed';
    m.endTime = Date.now();
    m.output = output.slice(0, 500); // 内存存摘要
    m.outputOffset = output.length;
    saveMemberOutput(id, output);     // 完整内容写磁盘
  }
}

export function appendMemberOutput(id: string, text: string) {
  const m = team.get(id);
  if (m) {
    m.output = text.slice(-500);      // 内存只保留最后 500 字
    m.outputOffset += text.length;
    saveMemberOutput(id, text);
  }
}

export function getMember(id: string): MemberState | undefined {
  return team.get(id);
}

export function getTeam(): Map<string, MemberState> {
  return team;
}
