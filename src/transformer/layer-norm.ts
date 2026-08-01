/**
 * Layer Normalization：对每个样本的特征维做归一化。
 * LayerNorm(x) = γ * (x - μ) / √(σ² + ε) + β
 * 与 BatchNorm 不同之处在于，LayerNorm 沿特征维统计，因此不受 batch 影响。
 */
import type { Mat } from './types'

export class LayerNorm {
  dModel: number
  epsilon: number
  /** 可学习的增益/偏置（骨架中初始化为 1 和 0） */
  gamma: number[]
  beta: number[]

  constructor(dModel: number, epsilon = 1e-5) {
    this.dModel = dModel
    this.epsilon = epsilon
    this.gamma = new Array(dModel).fill(1)
    this.beta = new Array(dModel).fill(0)
  }

  forward(x: Mat): Mat {
    return x.map((row) => this.normalize(row))
  }

  private normalize(row: number[]): number[] {
    const n = row.length
    const mean = row.reduce((a, b) => a + b, 0) / n
    const variance = row.reduce((a, v) => a + (v - mean) ** 2, 0) / n
    const std = Math.sqrt(variance + this.epsilon)
    return row.map((v, i) => ((v - mean) / std) * this.gamma[i] + this.beta[i])
  }
}
