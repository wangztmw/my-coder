/**
 * 编码器块（Encoder Block）：
 *  1. Multi-Head Self-Attention（自注意力，可带 padding mask）
 *  2. 残差连接 + LayerNorm
 *  3. Feed-Forward（位置前馈）
 *  4. 残差连接 + LayerNorm
 *
 * 采用 Pre-LN 顺序（先 norm 再 attn），训练更稳定。
 */
import type { Mat } from './types'
import type { MultiHeadAttention, AttentionMask } from './attention'
import type { FeedForward } from './feed-forward'
import type { LayerNorm } from './layer-norm'
import { MultiHeadAttention as RealAttn } from './attention'
import { FeedForward as RealFFN } from './feed-forward'
import { LayerNorm as RealLN } from './layer-norm'
import { addMat } from './math'

export class EncoderBlock {
  attn: MultiHeadAttention
  ffn: FeedForward
  norm1: LayerNorm
  norm2: LayerNorm

  constructor(dModel: number, numHeads: number, dFF: number) {
    this.attn = new RealAttn({ dModel, numHeads })
    this.ffn = new RealFFN({ dModel, dFF })
    this.norm1 = new RealLN(dModel)
    this.norm2 = new RealLN(dModel)
  }

  forward(x: Mat, mask?: AttentionMask): Mat {
    // 子层 1：多头自注意力 + 残差（Q=K=V=x）
    const nx = this.norm1.forward(x)
    const attnOut = this.attn.forward(nx, nx, nx, mask)
    const x1 = addMat(x, attnOut)

    // 子层 2：FFN + 残差
    const ffnOut = this.ffn.forward(this.norm2.forward(x1))
    return addMat(x1, ffnOut)
  }
}

/** 简化类型导出，方便外部只依赖构造函数参数。 */
export type { AttentionMask }
