export class RecodeError extends Error {
  constructor(
    message: string,
    readonly code: string = 'RECODE_ERROR',
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'RecodeError';
  }
}
