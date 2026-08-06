/**
 * Team 注册表 — Agent / 后台 Bash 的共享状态管理 + 磁盘持久化
 *
 * 主 Agent / 子 Agent / 后台 Bash 三方通过此模块读写成员状态。
 * 输出原子写入磁盘（tmp + rename），内存只存摘要。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { agentOutputPath, agentDir, SESSIONS_DIR } from './task_tree/paths.js';

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
  _sessionId?: string;       // 所属会话 ID（存储路径用）
  feedback?: string;         // 子Agent 主动反馈（双向通信）
  feedbackAt?: number;       // 反馈时间戳
  treeNodeId?: string;       // ★ 反向链接到 TreeNode.id
  treeRole?: 'planner' | 'supervisor' | 'worker';  // ★ Agent 的树角色
  depth: number;              // ★ 树深度（0=根直创, 1=子, 2=孙...）
  contextFiles?: string[];    // ★ 该 Agent 声明将操作的文件列表
  abortController?: AbortController;
  agentLoop?: {
    roundCount: number;
    toolUseCount: number;
    lastActivity?: string;
    lastOutput?: string;
  };
  pendingInstruction?: string;
}

const team = new Map<string, MemberState>();

function memberOutputPath(sessionId: string, id: string): string {
  return agentOutputPath(sessionId, id);
}

/** 原子写磁盘：先写 tmp 再 rename，防止写一半崩溃留下损坏文件 */
export function saveMemberOutput(sessionId: string, id: string, text: string): void {
  mkdirSync(agentDir(sessionId), { recursive: true });
  const path = memberOutputPath(sessionId, id);
  const tmp = path + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** 读取完整磁盘输出（通过 MemberState._sessionId 定位文件） */
export function readMemberOutput(id: string): string {
  const m = team.get(id);
  const sid = m?._sessionId || 'default';
  try { return readFileSync(memberOutputPath(sid, id), 'utf-8'); } catch { return ''; }
}

/** @deprecated 清理由 cleanOldSessions 统一处理 */
export function cleanOldMembers(): void {}

export function addMember(type: 'local_agent' | 'local_bash', subject: string, desc?: string, parentDepth?: number, sessionId?: string): MemberState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const depth = (parentDepth ?? -1) + 1;
  const sid = sessionId || 'default';
  const member: MemberState = {
    id, type, status: 'pending', subject,
    description: desc,
    startTime: Date.now(),
    _sessionId: sid,
    outputFile: memberOutputPath(sid, id),
    outputOffset: 0,
    notified: false,
    depth,
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
    saveMemberOutput(m._sessionId || 'default', id, output);     // 完整内容写磁盘
  }
}

export function appendMemberOutput(id: string, text: string) {
  const m = team.get(id);
  if (m) {
    m.output = text.slice(-500);      // 内存只保留最后 500 字
    m.outputOffset += text.length;
    saveMemberOutput(m._sessionId || 'default', id, text);
  }
}

export function getMember(id: string): MemberState | undefined {
  return team.get(id);
}

export function getTeam(): Map<string, MemberState> {
  return team;
}
