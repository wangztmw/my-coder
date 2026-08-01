/**
 * 多头自注意力（Multi-Head Self-Attention, MHSA）。
 *
 * Attention(Q, K, V) = softmax(Q·Kᵀ / √d_k) · V
 * 多头把 d_model 切分成 numHeads 个 d_head 维度并行做注意力，再把结果拼接起来。
 */
import type { Mat } from './types'
import { matmul, randMat } from './math'

export interface MHSAArgs {
  dModel: number
  numHeads: number
  maxSeqLen: number
}

export class MultiHeadSelfAttention {
  dModel: number
  numHeads: number
  dHead: number
  /** 投影矩阵（骨架里用随机初始化，真实训练时应是可学习参数） */
  Wq: Mat
  Wk: Mat
  Wv: Mat
  Wo: Mat

  constructor({ dModel, numHeads, maxSeqLen }: MHSAArgs) {
    this.dModel = dModel
    this.numHeads = numHeads
    this.dHead = dModel / numHeads
    if (this.dHead % 1 !== 0) {
      throw new Error('dModel 必须能被 numHeads 整除')
    }
    this.Wq = randMat(dModel, dModel)
    this.Wk = randMat(dModel, dModel)
    this.Wv = randMat(dModel, dModel)
    this.Wo = randMat(dModel, dModel)
  }

  /**
   * 前向传播。
   * @param x     输入 [seqLen, dModel]
   * @param mask  可选掩码（因果掩码 / padding 掩码），形状 [seqLen, seqLen]
   */
  forward(x: Mat, mask?: number[][]): Mat {
    const q = matmul(x, this.Wq)
    const k = matmul(x, this.Wk)
    const v = matmul(x, this.Wv)

    // 拆分成 numHeads 个头，每个头维度 dHead
    const heads: Mat[] = []
    for (let h = 0; h < this.numHeads; h++) {
      const qh = q.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      const kh = k.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      const vh = v.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      heads.push(this.scaledDotProductAttention(qh, kh, vh, mask))
    }

    // 拼接所有头，再经过 Wo 输出投影
    const seqLen = x.length
    const concat: Mat = Array.from({ length: seqLen }, (_, i) =>
      heads.flatMap((h) => h[i]),
    )
    return matmul(concat, this.Wo)
  }

  private scaledDotProductAttention(q: Mat, k: Mat, v: Mat, mask?: number[][]): Mat {
    const seqLen = q.length
    const scale = Math.sqrt(this.dHead)
    const scores: Mat = zeros(seqLen, seqLen)

    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < seqLen; j++) {
        scores[i][j] = dot(q[i], k[j]) / scale
        // 应用掩码：被屏蔽的位置置为 -∞ (-1e9 作为数值近似)
        if (mask && mask[i][j] === 0) scores[i][j] = -1e9
      }
    }
    return matmul(softmaxRows(scores), v)
  }
}

function zeros(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0))
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function softmaxRows(scores: Mat): Mat {
  return scores.map((row) => {
    const maxv = Math.max(...row)
    const exps = row.map((v) => Math.exp(v - maxv))
    const sum = exps.reduce((a, b) => a + b, 0)
    return exps.map((v) => v / sum)
  })
}
