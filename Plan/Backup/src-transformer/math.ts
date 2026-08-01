import type { Mat } from './types'

/** 极简的伪随机数生成器（mulberry32），保证结果可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 标准正态分布采样（Box–Muller）。 */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 生成一个服从均匀分布 [-bound, bound] 的二维矩阵。 */
export function randMat(rows: number, cols: number, bound = 0.05): Mat {
  const rand = mulberry32(42)
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (rand() * 2 - 1) * bound),
  )
}

/** 生成一个服从标准正态分布的二维矩阵。 */
export function randnMat(rows: number, cols: number, seed = 42): Mat {
  const rand = mulberry32(seed)
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => gaussian(rand)))
}

/** 生成一个全是 0 的二维矩阵。 */
export function zerosMat(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0))
}

/** 矩阵乘法：A(r×k) · B(k×c) -> C(r×c)。 */
export function matmul(a: Mat, b: Mat): Mat {
  if (a.length === 0) return []
  const r = a.length
  const k = a[0].length
  const c = b[0].length
  const out = zerosMat(r, c)
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      let s = 0
      for (let t = 0; t < k; t++) s += a[i][t] * b[t][j]
      out[i][j] = s
    }
  }
  return out
}

/** 矩阵对向量逐行相加（广播）。 */
export function addVec(mat: Mat, vec: number[]): Mat {
  return mat.map((row) => row.map((v, j) => v + vec[j]))
}

/** 向量点积。 */
export function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 两个矩阵逐元素相加。 */
export function addMat(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]))
}

/** 对矩阵最后一行维度求 mean 并返回该向量（用于句级平均池化）。 */
export function meanPool(mat: Mat): number[] {
  if (mat.length === 0) return []
  const cols = mat[0].length
  const out: number[] = new Array(cols).fill(0)
  for (const row of mat) {
    for (let j = 0; j < cols; j++) out[j] += row[j]
  }
  return out.map((v) => v / mat.length)
}
