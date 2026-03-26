export class PlanetScaleAPIError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "PlanetScaleAPIError";
    this.statusCode = statusCode;
    this.details = details;
  }
}
