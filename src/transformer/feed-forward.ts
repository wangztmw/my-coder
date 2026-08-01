/**
 * 位置前馈网络（Position-wise Feed-Forward Network）。
 * 每个位置独立应用同一个两层的 MLP：FFN(x) = max(0, x·W1 + b1)·W2 + b2
 * 惯例如 ReLU 或 GELU 激活。
 */
import type { Mat } from './types'
import { matmul, addVec, randMat } from './math'

export interface FFNArgs {
  dModel: number
  dFF: number
}

export class FeedForward {
  dModel: number
  dFF: number
  W1: Mat
  b1: number[]
  W2: Mat
  b2: number[]

  constructor({ dModel, dFF }: FFNArgs) {
    this.dModel = dModel
    this.dFF = dFF
    // 骨架阶段用随机初始化，真实训练时应为可学习参数
    this.W1 = randMat(dModel, dFF)
    this.b1 = new Array(dFF).fill(0)
    this.W2 = randMat(dFF, dModel)
    this.b2 = new Array(dModel).fill(0)
  }

  forward(x: Mat): Mat {
    // 线性 1 + ReLU
    const hidden = addVec(matmul(x, this.W1), this.b1).map((row) => row.map(relu))
    // 线性 2
    return addVec(matmul(hidden, this.W2), this.b2)
  }
}

function relu(v: number): number {
  return Math.max(0, v)
}
