/**
 * Transformer 骨架的统一出口。
 * 外部只需 `import { Transformer } from './transformer'` 即可使用。
 */
export { Transformer } from './model'
export type { TransformerConfig } from './types'
export { defaultConfig } from './types'
export { MultiHeadSelfAttention } from './multi-head-attention'
export { MultiHeadAttention } from './attention'
export { FeedForward } from './feed-forward'
export { LayerNorm } from './layer-norm'
export { Embedding, LMHead } from './embedding'
export { causalMask, paddingMask, combineMasks } from './mask'
export {
  sinusoidalPositionalEncoding,
  learnablePositionalEncoding,
} from './positional-encoding'
export { matmul, randMat, randnMat, zerosMat, addMat, addVec } from './math'
