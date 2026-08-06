import { BashTool } from './BashTool/BashTool.js';
import { FileReadTool } from './FileReadTool/FileReadTool.js';
import { FileWriteTool } from './FileWriteTool/FileWriteTool.js';
import { FileEditTool } from './FileEditTool/FileEditTool.js';
import { GlobTool } from './GlobTool/GlobTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { WebSearchTool } from './WebSearchTool/WebSearchTool.js';
import { WebFetchTool } from './WebFetchTool/WebFetchTool.js';
import { MCPTool } from './MCPTool/MCPTool.js';
import { SkillTool } from './SkillTool/SkillTool.js';
import { AgentTool } from './AgentTool/AgentTool.js';
import { AgentTeamTool } from './AgentTeamTool/AgentTeamTool.js';
import { TreeCmdTool } from './TreeCmdTool/TreeCmdTool.js';
export function getAllTools() {
    return [
        BashTool,
        FileReadTool,
        FileWriteTool,
        FileEditTool,
        GlobTool,
        GrepTool,
        WebSearchTool,
        WebFetchTool,
        MCPTool,
        SkillTool,
        AgentTool,
        AgentTeamTool,
        TreeCmdTool,
    ].filter(t => t.isEnabled());
}
