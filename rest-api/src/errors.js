export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const err = (status, code, message) => new ApiError(status, code, message);
