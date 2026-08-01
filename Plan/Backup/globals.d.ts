/**
 * my-coder — Global type declarations for stripped code
 *
 * Stubs for Anthropic-internal macros and deleted module types.
 */

// Anthropic build-time macros
declare var MACRO: Record<string, string>;

// Bun runtime (used in some utility files)
declare var Bun: {
  env: Record<string, string>;
  file(path: string): { exists(): Promise<boolean> };
};

// Analytics type (stripped)
declare type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = {};

// React JSX (tools reference JSX in unused render methods)
declare namespace React {
  type ReactNode = unknown;
  type CSSProperties = Record<string, string>;
}

// lodash-es
declare module 'lodash-es/memoize.js' {
  export default function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T;
}
declare module 'lodash-es/mapValues.js' {
  export default function mapValues<T, R>(obj: Record<string, T>, fn: (v: T) => R): Record<string, R>;
}
declare module 'lodash-es/zipObject.js' {
  export default function zipObject<K extends string, V>(keys: K[], values: V[]): Record<K, V>;
}
declare module 'lodash-es/last.js' {
  export default function last<T>(arr: T[]): T | undefined;
}

// bun:bundle — stripped
declare module 'bun:bundle' {
  export function feature(_name: string): boolean;
}

// Missing modules from deleted directories
declare module 'src/bootstrap/state.js';
declare module './bootstrap/state.js';
declare module '../../bootstrap/state.js';
declare module '../bootstrap/state.js';
declare module './settings/settings.js';
declare module '../settings/settings.js';
declare module '../../settings/settings.js';

// Stripped image processors
declare module 'sharp';
declare module 'image-processor-napi';

// figures (terminal figures library)
declare module 'figures' {
  const figures: Record<string, string>;
  export default figures;
}

// Missing React component imports
declare module './UI.js';
declare module '../../components/MessageResponse.js';
declare module '../../components/design-system/KeyboardShortcutHint.js';
declare module '../../components/mcp/types.js';
declare module '../../components/shell/OutputLine.js';
declare module '../../components/shell/ShellTimeDisplay.js';
declare module '../../components/FallbackToolUseErrorMessage.js';
declare module '../../components/Spinner.js';

// Ink imports
declare module '../../ink.js';
declare module '../../ink/stringWidth.js';
declare module '../../keybindings/defaultBindings.js';
declare module '../../keybindings/loadUserBindings.js';
declare module '../../keybindings/reservedShortcuts.js';
declare module '../../keybindings/schema.js';

// Memory directory
declare module '../../memdir/memoryAge.js';
declare module '../../memdir/paths.js';

// Services (stripped)
declare module './claudeai.js';
declare module './SdkControlTransport.js';
declare module '../../services/SessionMemory/sessionMemoryUtils.js';
declare module '../../services/api/claude.js';
declare module '../../services/api/client.js';
declare module '../../services/api/logging.js';
declare module '../../services/mcp/vscodeSdkMcp.js';
declare module '../../services/policyLimits/index.js';
declare module '../../services/skillSearch/featureCheck.js';
declare module '../../services/teamMemorySync/teamMemSecretGuard.js';
declare module '../../skills/mcpSkills.js';

// Tool files (stripped)
declare module './NotebookEditTool/constants.js';
declare module '../NotebookEditTool/constants.js';
declare module './PowerShellTool/toolName.js';
declare module '../../tools/NotebookEditTool/constants.js';
declare module '../../tools/PowerShellTool/toolName.js';
declare module '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js';
declare module '../../tools/McpAuthTool/McpAuthTool.js';
declare module '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js';
declare module '../../tools/SyntheticOutputTool/SyntheticOutputTool.js';
declare module '../../tools/TaskOutputTool/TaskOutputTool.js';

// Utils (stripped)
declare module '../utils/analytics.js';
declare module '../../utils/file.js';
declare module '../../utils/permissions/PermissionResult.js';
declare module '../../utils/permissions/shellRuleMatching.js';
declare module '../../utils/permissions/denialTracking.js';
declare module '../../utils/plugins/mcpPluginIntegration.js';
declare module '../../utils/plugins/pluginLoader.js';
declare module '../../utils/settings/constants.js';
declare module '../../utils/settings/managedPath.js';
declare module '../../utils/settings/pluginOnlyPolicy.js';
declare module '../../utils/settings/types.js';
declare module '../../utils/settings/validation.js';
declare module '../../utils/secureStorage/macOsKeychainHelpers.js';
declare module '../outputStyles/loadOutputStylesDir.js';
declare module '../utils/plugins/loadPluginOutputStyles.js';

// Entrypoints (stripped)
declare module '../../entrypoints/agentSdkTypes.js';

// CLI
declare module '../../cli/print.js';

// Misc
declare module 'src/types/message.js';
declare module '../../types/tools.js';
declare module '../bridge/sessionIdCompat.js';
declare module '../../utils/claudeInChrome/common.js';
declare module '../../state/AppState.js';
declare module '../state/AppState.js';
declare module '../../constants/querySource.js';
declare module '../../tools/AgentTool/loadAgentsDir.js' {
  export type AgentDefinition = { name: string; description: string };
  export type AgentDefinitionsResult = AgentDefinition[];
}

// More misc
declare module './constants.js';
declare module '../../constants/figures.js';
declare module '../../constants/tools.js';
declare module '../../constants/querySource.js';
declare module '../../utils/secureStorage/index.js';
declare module '../../utils/secureStorage/plainTextStorage.js';
declare module '../../utils/hooks/hookHelpers.js';
declare module '../../utils/hooks.js';
declare module '../../utils/plugins/loadPluginOutputStyles.js';
declare module '../../utils/plugins/pluginLoader.js';
declare module '../../utils/plugins/mcpPluginIntegration.js';
declare module '../../utils/model/modelCost.js';
declare module '../../utils/log.js';
declare module '../../utils/messages.js';
declare module '../../utils/detectRepository.js';
declare module '../../utils/fileHistory.js';
