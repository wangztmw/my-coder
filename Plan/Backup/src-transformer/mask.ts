/**
 * 注意力掩码（Attention Mask）构造工具。
 * Transformer 中有两类掩码：
 *  - padding mask：屏蔽掉补齐（padding）的 token，防止它们参与注意力。
 *  - look-ahead mask（因果掩码）：Decode 时每个位置只能看到自己及之前的位置。
 */

/**
 * 构造因果掩码（下三角矩阵，含对角线）。
 * 用于 Decoder 的自注意力，保证预测当前 token 时看不到未来信息。
 * @param seqLen 序列长度
 */
export function causalMask(seqLen: number): number[][] {
  return Array.from({ length: seqLen }, (_, i) =>
    Array.from({ length: seqLen }, (_, j) => (j <= i ? 1 : 0)),
  )
}

/**
 * 构造 padding mask。
 * @param tokens   输入 token id 序列
 * @param padToken padding 的 token id，通常为 0
 * @returns 二维掩码，无效（padding）位置为 0，其余为 1
 */
export function paddingMask(tokens: number[], padToken = 0): number[][] {
  const len = tokens.length
  const valid = tokens.map((t) => (t === padToken ? 0 : 1))
  // [i, j] = valid[i] && valid[j]，即任意一边是 padding 则整格屏蔽
  return valid.map((a) => valid.map((b) => (a && b ? 1 : 0)))
}

/**
 * 组合多个掩码（与操作）：常用于把 padding mask 和 causal mask 叠加。
 */
export function combineMasks(...masks: number[][][]): number[][] | undefined {
  if (masks.length === 0) return undefined
  const rows = masks[0].length
  return Array.from({ length: rows }, (_, i) =>
    Array.from({ length: rows }, (_, j) =>
      masks.every((m) => m[i][j] === 1) ? 1 : 0,
    ),
  )
}
