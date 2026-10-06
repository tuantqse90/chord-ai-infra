// Engine errors carry their HTTP meaning by name and code (src/botRoutes.ts maps them): input 400, limits 409, live 403.
export class BotInputError extends Error {
  readonly status = 400;
  readonly code = "bad_request";
  constructor(message: string) {
    super(message);
    this.name = "BotInputError";
  }
}

export class BotLimitError extends Error {
  readonly status = 409;
  readonly code = "too_many_bots";
  constructor(message: string) {
    super(message);
    this.name = "BotLimitError";
  }
}

/** Live mode signs from the person's wallet through Privy session signers, which the owner has not switched on yet. */
export class BotLiveError extends Error {
  readonly status = 403;
  readonly code = "live_not_enabled";
  constructor(message = "Live mode is not switched on yet: bots run in paper mode (real Jupiter quotes, nothing is sent).") {
    super(message);
    this.name = "BotLiveError";
  }
}
