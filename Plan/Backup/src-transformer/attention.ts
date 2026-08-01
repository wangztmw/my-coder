/**
 * 通用多头注意力层（支持编码器自注意力 / 解码器交叉注意力的前向计算核心）。
 * 与 multi-head-attention.ts 的区别：
 *  - 这里 K/V 由 memory（编码器输出）提供，用于交叉注意力；
 *  - 同时支持作用于 Q 的因果掩码、以及 memory 上的 padding 掩码。
 */
import type { Mat } from './types'
import { matmul, randMat, zerosMat } from './math'

export interface AttentionArgs {
  dModel: number
  numHeads: number
}

/** 掩码：qMask 是 attention 矩阵掩码（作用于 scores），kvMask 作用在 K 上。 */
export interface AttentionMask {
  /** 形状 [qLen, kLen]，0 表示屏蔽 */
  scoresMask?: number[][]
}

export class MultiHeadAttention {
  dModel: number
  numHeads: number
  dHead: number
  Wq: Mat
  Wk: Mat
  Wv: Mat
  Wo: Mat

  constructor({ dModel, numHeads }: AttentionArgs) {
    this.dModel = dModel
    this.numHeads = numHeads
    this.dHead = dModel / numHeads
    if (this.dHead % 1 !== 0) throw new Error('dModel 必须能被 numHeads 整除')
    this.Wq = randMat(dModel, dModel)
    this.Wk = randMat(dModel, dModel)
    this.Wv = randMat(dModel, dModel)
    this.Wo = randMat(dModel, dModel)
  }

  /**
   * @param query  多头注意力的 query，形状 [qLen, dModel]
   * @param key    来自 memory（交叉注意力）或 query 自身，形状 [kvLen, dModel]
   * @param value  同 key
   * @param mask   可选掩码
   */
  forward(query: Mat, key: Mat, value: Mat, mask?: AttentionMask): Mat {
    const q = matmul(query, this.Wq)
    const k = matmul(key, this.Wk)
    const v = matmul(value, this.Wv)

    const heads: Mat[] = []
    for (let h = 0; h < this.numHeads; h++) {
      const qh = q.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      const kh = k.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      const vh = v.map((row) => row.slice(h * this.dHead, (h + 1) * this.dHead))
      heads.push(this.scaledDotProductAttention(qh, kh, vh, mask))
    }

    const qLen = query.length
    const concat: Mat = Array.from({ length: qLen }, (_, i) => heads.flatMap((h) => h[i]))
    return matmul(concat, this.Wo)
  }

  private scaledDotProductAttention(
    q: Mat,
    k: Mat,
    v: Mat,
    mask?: AttentionMask,
  ): Mat {
    const qLen = q.length
    const kLen = k.length
    const scale = Math.sqrt(this.dHead)
    const scores = zerosMat(qLen, kLen)

    for (let i = 0; i < qLen; i++) {
      for (let j = 0; j < kLen; j++) {
        let s = 0
        for (let t = 0; t < q[i].length; t++) s += q[i][t] * k[j][t]
        scores[i][j] = s / scale
        if (mask?.scoresMask && mask.scoresMask[i]?.[j] === 0) scores[i][j] = -1e9
      }
    }
    return matmul(softmaxRows(scores), v)
  }
}

function softmaxRows(scores: Mat): Mat {
  return scores.map((row) => {
    const maxv = Math.max(...row)
    const exps = row.map((v) => Math.exp(v - maxv))
    const sum = exps.reduce((a, b) => a + b, 0)
    return exps.map((v) => v / sum)
  })
}
