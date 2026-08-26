/**
 * Shared, dependency-free constants.
 *
 * Kept out of `config.js` on purpose: that module owns dotenv and validation,
 * while these values must stay importable from pure, unit-tested modules (cards,
 * handlers) with no environment present.
 */

/**
 * Command prefix.
 *
 * `/` is the prefix every *bot* listens on. A self-bot that shares it gets its
 * commands intercepted, echoed or answered by whatever bot happens to sit in the
 * same chat, and Telegram clients pop a command autocomplete over them. A
 * leading dot is inert for bots and unambiguous for us.
 */
export const COMMAND_PREFIX = '.';

/**
 * Matches a candidate command at the start of a message.
 *
 * A letter is required after the dot so ordinary text (`...`, `.5`, a leading
 * ellipsis) is never mistaken for a command.
 */
export const COMMAND_PATTERN = /^\s*\.[a-zA-Z]/;

/** `cmd('save')` -> `.save`. Accepts a bare or already-prefixed name. */
export const cmd = (name) => `${COMMAND_PREFIX}${String(name ?? '').replace(/^[./!]+/, '')}`;
