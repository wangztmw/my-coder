/**
 * tools-v2 — Clean Tool interface
 *
 * 按 Claude Code 原始架构重写，零断裂依赖。
 */
// ============================================================
// buildTool factory
// ============================================================
export function buildTool(def) {
    return {
        isReadOnly: () => false,
        isEnabled: () => true,
        isConcurrencySafe: () => false,
        checkPermissions: async () => ({ behavior: 'allow' }),
        prompt: async () => def.name,
        userFacingName: () => def.name,
        ...def,
    };
}
