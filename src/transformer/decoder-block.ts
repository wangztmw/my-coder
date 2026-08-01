/**
 * 解码器块（Decoder Block）：
 *  1. Masked Multi-Head Self-Attention（带因果掩码）
 *  2. 残差 + LayerNorm
 *  3. Cross-Attention（以编码器输出 memory 为 K/V）
 *  4. 残差 + LayerNorm
 *  5. Feed-Forward
 *  6. 残差 + LayerNorm
 *
 * 采用 Pre-LN 顺序。
 */
import type { Mat } from './types'
import type { MultiHeadAttention, AttentionMask } from './attention'
import type { FeedForward } from './feed-forward'
import type { LayerNorm } from './layer-norm'
import { MultiHeadAttention as RealAttn } from './attention'
import { FeedForward as RealFFN } from './feed-forward'
import { LayerNorm as RealLN } from './layer-norm'
import { addMat } from './math'

export class DecoderBlock {
  selfAttn: MultiHeadAttention
  crossAttn: MultiHeadAttention
  ffn: FeedForward
  norm1: LayerNorm
  norm2: LayerNorm
  norm3: LayerNorm

  constructor(dModel: number, numHeads: number, dFF: number) {
    this.selfAttn = new RealAttn({ dModel, numHeads })
    this.crossAttn = new RealAttn({ dModel, numHeads })
    this.ffn = new RealFFN({ dModel, dFF })
    this.norm1 = new RealLN(dModel)
    this.norm2 = new RealLN(dModel)
    this.norm3 = new RealLN(dModel)
  }

  forward(
    x: Mat,
    memory: Mat,
    selfMask?: AttentionMask,
    crossMask?: AttentionMask,
  ): Mat {
    // 子层 1：因果自注意力 + 残差
    const nx1 = this.norm1.forward(x)
    const selfOut = this.selfAttn.forward(nx1, nx1, nx1, selfMask)
    const x1 = addMat(x, selfOut)

    // 子层 2：交叉注意力 + 残差（K/V 来自编码器输出 memory）
    const nx2 = this.norm2.forward(x1)
    const crossOut = this.crossAttn.forward(nx2, memory, memory, crossMask)
    const x2 = addMat(x1, crossOut)

    // 子层 3：FFN + 残差
    const ffnOut = this.ffn.forward(this.norm3.forward(x2))
    return addMat(x2, ffnOut)
  }
}
