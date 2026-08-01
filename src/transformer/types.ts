/**
 * Transformer 统一的张量 / 配置类型定义。
 *
 * 这里刻意不依赖具体的深度学习框架（如 PyTorch / JAX / tfjs），
 * 而把“张量”抽象成最简单的二维数值数组。
 * 这样骨架的每一层都易于替换成真实的框架实现。
 */

/** 二维张量，第一维是 batch*seq，第二维是特征维度。 */
export type Mat = number[][]

/** Transformer 的基础超参数。 */
export interface TransformerConfig {
  /** 词表大小 */
  vocabSize: number
  /** 模型隐藏维度 d_model */
  dModel: number
  /** 注意力头数 */
  numHeads: number
  /** FFN 中间层维度，惯例取 4 * dModel */
  dFF: number
  /** Encoder 层数 */
  numEncoderLayers: number
  /** Decoder 层数 */
  numDecoderLayers: number
  /** Dropout 概率 */
  dropout: number
  /** 序列最大长度 */
  maxSeqLen: number
  /** 总参数中的随机噪声种子，便于复现 */
  seed?: number
}

/** 根据惯例给出默认配置。 */
export function defaultConfig(partial?: Partial<TransformerConfig>): TransformerConfig {
  return {
    vocabSize: 32000,
    dModel: 512,
    numHeads: 8,
    dFF: 2048,
    numEncoderLayers: 6,
    numDecoderLayers: 6,
    dropout: 0.1,
    maxSeqLen: 512,
    ...partial,
  }
}
