// Limits on client input, shared by the REST and WebSocket transports.

/** Restricted charset: conversationId ends up in logs, DB keys, maybe paths. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const MAX_MESSAGE_CHARS = 32_000;
