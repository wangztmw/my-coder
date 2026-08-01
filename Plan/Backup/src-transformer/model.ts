/**
 * Transformer 主模型 —— Encoder-Decoder 整体骨架。
 *
 * 结构流程：
 *   src_ids -> Embedding -> (+ 位置编码) -> [Encoder × N] -> memory
 *   tgt_ids -> Embedding -> (+ 位置编码) -> [Decoder × N] -> hidden
 *   hidden -> LMHead -> logits
 *
 * 该文件把前向流程串联起来，逻辑清晰、可读性强。
 * 真实训练（反向传播/优化器）不在这里实现，骨架面向理解与扩展。
 */
import type { Mat, TransformerConfig } from './types'
import { defaultConfig } from './types'
import { sinusoidalPositionalEncoding } from './positional-encoding'
import { Embedding, LMHead } from './embedding'
import { EncoderBlock } from './encoder-block'
import { DecoderBlock } from './decoder-block'
import { causalMask, paddingMask } from './mask'
import type { AttentionMask } from './attention'
import { addMat } from './math'

export class Transformer {
  config: TransformerConfig

  srcEmbedding: Embedding
  tgtEmbedding: Embedding
  lmHead: LMHead
  positionEncoding: Mat

  encoders: EncoderBlock[]
  decoders: DecoderBlock[]

  constructor(config?: Partial<TransformerConfig>) {
    this.config = defaultConfig(config)
    const { dModel, numHeads, dFF, vocabSize, numEncoderLayers, numDecoderLayers, maxSeqLen } =
      this.config

    this.srcEmbedding = new Embedding(vocabSize, dModel)
    this.tgtEmbedding = new Embedding(vocabSize, dModel)
    this.lmHead = new LMHead(vocabSize, dModel)
    this.positionEncoding = sinusoidalPositionalEncoding(maxSeqLen, dModel)

    this.encoders = Array.from(
      { length: numEncoderLayers },
      () => new EncoderBlock(dModel, numHeads, dFF),
    )
    this.decoders = Array.from(
      { length: numDecoderLayers },
      () => new DecoderBlock(dModel, numHeads, dFF),
    )
  }

  /**
   * 完整前向传播（训练模式常用于 teacher-forcing）。
   * @param srcIds   源序列 token，形状 [srcLen]
   * @param tgtIds   目标序列 token，形状 [tgtLen]
   * @param srcPad   padding token id（用于构造 padding mask）
   * @returns 每个目标位置的 logits，形状 [tgtLen, vocabSize]
   */
  forward(srcIds: number[], tgtIds: number[], srcPad = 0): Mat {
    const memory = this.encode(srcIds, srcPad)
    const hidden = this.decode(memory, tgtIds, srcPad)
    return this.lmHead.forward(hidden)
  }

  /** 编码器：src -> memory */
  encode(srcIds: number[], srcPad = 0): Mat {
    let x = addMat(this.srcEmbedding.forward(srcIds), this.positionEncoding.slice(0, srcIds.length))
    const mask: AttentionMask = { scoresMask: paddingMask(srcIds, srcPad) }
    for (const enc of this.encoders) x = enc.forward(x, mask)
    return x
  }

  /**
   * 解码器：memory + tgt -> hidden。
   * @param partialTgt 已生成的目标前缀（序列解码/推理时逐 token 增长）
   */
  decode(memory: Mat, partialTgt: number[]): Mat {
    let x = addMat(
      this.tgtEmbedding.forward(partialTgt),
      this.positionEncoding.slice(0, partialTgt.length),
    )
    // 因果掩码：只看自己及之前的位置
    const selfMask: AttentionMask = { scoresMask: causalMask(partialTgt.length) }
    // 交叉注意力掩码（memory 上的 KV padding 掩码）
    const crossMask: AttentionMask = {
      scoresMask: paddingMaskForKV(memory.length, partialTgt.length),
    }
    for (const dec of this.decoders) {
      x = dec.forward(x, memory, selfMask, crossMask)
    }
    return x
  }

  /**
   * 自回归生成：给定源序列和起始 token，逐个采样输出。
   * @param srcIds      源序列
   * @param startToken  序列起始 token（如 <sos>）
   * @param maxNewTokens 最多生成的 token 数
   * @returns 生成的 token id 列表（不含起始 token）
   */
  generate(srcIds: number[], startToken: number, maxNewTokens = 50): number[] {
    const memory = this.encode(srcIds)
    const generated: number[] = []
    let tgt: number[] = [startToken]

    for (let step = 0; step < maxNewTokens; step++) {
      const hidden = this.decode(memory, tgt)
      const logits = this.lmHead.forward(hidden)
      const lastLogits = logits[logits.length - 1]
      // 贪心：取最大概率 token（骨架最简单策略，可替换为 temperature / top-k 采样）
      const next = argmax(lastLogits)
      if (next === 2) break // 假设 id=2 为结束符 <eos>
      generated.push(next)
      tgt.push(next)
    }
    return generated
  }
}

/** 供 decode 使用的 memory 上 KV padding 掩码。 */
function paddingMaskForKV(kvLen: number, qLen: number): number[][] {
  // 交叉注意力通常只保留 src 的有效 token，本文掩码简化为全 1（无 padding）。
  return Array.from({ length: qLen }, () => new Array(kvLen).fill(1))
}

function argmax(vec: number[]): number {
  let best = 0
  for (let i = 1; i < vec.length; i++) if (vec[i] > vec[best]) best = i
  return best
}
