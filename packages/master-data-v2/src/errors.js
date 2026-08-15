export class MasterValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MasterValidationError';
  }
}

export class MasterConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MasterConflictError';
    this.details = details;
  }
}

export class HistoryPendingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'HistoryPendingError';
    this.details = details;
  }
}
