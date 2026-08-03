/**
 * 终端行宽保护 —— 防止超长行触发 macOS Terminal SwiftUI 布局递归崩溃。
 *
 * 问题：LLM 输出的超长行（如宽表格、长代码行）会触发 Terminal 的 Text 视图
 * intrinsic size 计算不收敛 → 布局递归 → nano malloc corruption → SIGTRAP。
 *
 * 解决：拦截 stdout/stderr 的 write，在写入 PTY 之前自动将超长行折行。
 * Claude Code 通过 Ink/Yoga 布局引擎隐式获得同等保护。
 */
import type { WriteStream } from 'node:tty';

/** ANSI 转义序列的终止字符：m(SGR), A-G(光标移动), H/J/K(擦除), h/l(模式), n(DSR), s/u(保存恢复) */
const ANSI_END = /^[A-Za-z]$/;

/** 计算去掉 ANSI 转义序列后的可见字符数 */
function stripANSIWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

/** 将超长行在指定宽度处折行。ANSI 码不计入宽度，折点不切断 ANSI 序列。 */
function breakLine(line: string, maxWidth: number): string {
  const parts: string[] = [];
  let visible = 0;
  let lastBreak = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      // 跳过整个 ANSI 转义序列（包括非 SGR 的光标控制、擦除等）
      const start = i;
      i++; // 跳过 ESC
      if (i < line.length && line[i] === '[') {
        i++; // 跳过 '['
        while (i < line.length && !ANSI_END.test(line[i])) i++; // 跳到终止字母
      }
      // 如果上述逻辑没匹配到（异常输入），回退：至少跳过 ESC 本身
      if (i >= line.length || !ANSI_END.test(line[i])) i = start;
      continue;
    }
    visible++;
    if (visible >= maxWidth) {
      parts.push(line.slice(lastBreak, i + 1));
      lastBreak = i + 1;
      visible = 0;
    }
  }
  if (lastBreak < line.length) parts.push(line.slice(lastBreak));
  return parts.join('\n');
}

/** Monkey-patch 一个 WriteStream，确保写入的所有文本单行不超终端宽度 */
function wrapStream(stream: WriteStream): void {
  const original = stream.write.bind(stream);
  stream.write = function (chunk: any, encoding?: any, callback?: any): boolean {
    const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf-8');
    const width = stream.columns || 120;
    const wrapped = text.split('\n').map(line => {
      if (stripANSIWidth(line) <= width) return line;
      return breakLine(line, width);
    }).join('\n');
    return original(wrapped, encoding, callback);
  };
}

/** 注册终端行宽保护。必须在任何输出之前调用。 */
export function protectTerminal(): void {
  wrapStream(process.stdout as WriteStream);
  wrapStream(process.stderr as WriteStream);
}
