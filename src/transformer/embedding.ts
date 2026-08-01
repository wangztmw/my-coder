/**
 * 词嵌入（Token Embedding）层。
 * 把离散的 token id 映射为稠密向量，是模型的输入入口。
 * 同时提供一个输出投影头（LM Head）用于从隐藏状态预测下一 token。
 */
import type { Mat } from './types'
import { matmul, randnMat } from './math'

export class Embedding {
  vocabSize: number
  dModel: number
  /** 权重矩阵 [vocabSize, dModel] */
  table: Mat

  constructor(vocabSize: number, dModel: number) {
    this.vocabSize = vocabSize
    this.dModel = dModel
    // 骨架阶段用标准正态随机初始化，真实训练时为可学习参数
    this.table = randnMat(vocabSize, dModel)
  }

  /**
   * @param tokens token id 列表 [seqLen]
   * @returns 嵌入序列 [seqLen, dModel]
   */
  forward(tokens: number[]): Mat {
    return tokens.map((id) => {
      if (id < 0 || id >= this.vocabSize) throw new Error(`token id 越界: ${id}`)
      return this.table[id]
    })
  }
}

/**
 * 输出投影头。骨架里刻意与嵌入共享尺寸但独立权重（真实模型常做权重绑定 tie-weights）。
 */
export class LMHead {
  vocabSize: number
  dModel: number
  weight: Mat

  constructor(vocabSize: number, dModel: number) {
    this.vocabSize = vocabSize
    this.dModel = dModel
    this.weight = randnMat(vocabSize, dModel)
  }

  /**
   * 对每个位置计算 logits。
   * @param hidden 隐藏状态 [seqLen, dModel]
   * @returns logits [seqLen, vocabSize]
   */
  forward(hidden: Mat): Mat {
    // logits = hidden · weightᵀ
    const seqLen = hidden.length
    const out: Mat = Array.from({ length: seqLen }, () =>
      new Array(this.vocabSize).fill(0),
    )
    for (let i = 0; i < seqLen; i++) {
      for (let v = 0; v < this.vocabSize; v++) {
        out[i][v] = dot(hidden[i], this.weight[v])
      }
    }
    return out
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
