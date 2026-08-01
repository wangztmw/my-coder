export type Message = { role: string; content: unknown };
export type AssistantMessage = Message & { role: 'assistant' };
export type UserMessage = Message & { role: 'user' };
export type SystemMessage = Message & { role: 'system' };
export type ProgressMessage<T = unknown> = Message & { data?: T };
export type AttachmentMessage = Message;
export type SystemLocalCommandMessage = SystemMessage;
