/**
 * 位置编码：Transformer 没有顺序概念，必须注入位置信息。
 * 这里实现了经典的正弦/余弦位置编码。
 */
import type { Mat } from './types'

function positionalAngle(pos: number, i: number, dModel: number): number {
  return pos / Math.pow(10000, (2 * i) / dModel)
}

/**
 * 生成位置编码矩阵，形状 [maxSeqLen, dModel]。
 * - 偶数索引维度: sin(pos / 10000^(2i/d))
 * - 奇数索引维度: cos(pos / 10000^(2i/d))
 */
export function sinusoidalPositionalEncoding(maxSeqLen: number, dModel: number): Mat {
  const pe: Mat = Array.from({ length: maxSeqLen }, (_, pos) =>
    Array.from({ length: dModel }, (_, i) => {
      const angle = positionalAngle(pos, Math.floor(i / 2), dModel)
      return i % 2 === 0 ? Math.sin(angle) : Math.cos(angle)
    }),
  )
  return pe
}

/** 生成可学习的绝对位置编码（骨架接口，占位实现）。 */
export function learnablePositionalEncoding(maxSeqLen: number, dModel: number): Mat {
  // 实际训练中应作为参数参与梯度更新，骨架阶段用随机初始化替代。
  return Array.from({ length: maxSeqLen }, () => Array.from({ length: dModel }, () => 0))
}
