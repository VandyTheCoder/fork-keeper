// Error types shared across modules. Their messages are shown to users as-is.

export class InputError extends Error {
  constructor(messages) {
    super(messages.join('\n'));
    this.name = 'InputError';
    this.messages = messages;
  }
}

export class FatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalError';
  }
}

export class PartialStop extends Error {
  constructor(reason) {
    super(reason === 'write-budget' ? 'Write budget for this run is used up' : 'GitHub rate limit reached');
    this.name = 'PartialStop';
    this.reason = reason;
  }
}
