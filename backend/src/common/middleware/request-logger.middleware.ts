import { Logger } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

const logger = new Logger('HTTP');

/**
 * Logs every HTTP request with its status, duration and — for failures — the
 * server's own error message.
 *
 * Deliberately Express middleware rather than a Nest interceptor. An
 * interceptor only runs for requests that **matched a route**, so a client
 * calling the wrong path produces a 404 that never gets logged at all. That is
 * precisely the failure this exists to make visible: "the frontend is hitting
 * an endpoint that does not exist" is invisible from the server side otherwise.
 *
 * Request bodies are never logged — they carry passwords, PINs and refresh
 * tokens, and hashing those is pointless if they land in a log file. Response
 * bodies are read only on 4xx/5xx, where they contain validation messages
 * rather than secrets.
 */
export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = Date.now();

  // Capture the response body so failures can report *why*. `res.json` is
  // wrapped rather than the stream, so this costs nothing on success.
  let capturedBody: unknown;
  const originalJson = response.json.bind(response);
  response.json = (body: unknown) => {
    capturedBody = body;
    return originalJson(body);
  };

  response.on('finish', () => {
    const ms = Date.now() - startedAt;
    const status = response.statusCode;
    const base = `${request.method} ${request.originalUrl} ${status} ${ms}ms`;

    if (status < 400) {
      logger.log(base);
      return;
    }

    const detail = describe(capturedBody);
    const line = detail === undefined ? base : `${base} — ${detail}`;

    if (status === 404) {
      // The single most common integration fault, and the least self-evident.
      logger.warn(`${line} — no route matched (is the client missing the /api/v1 prefix?)`);
    } else if (status >= 500) {
      logger.error(line);
    } else {
      logger.warn(line);
    }
  });

  next();
}

/** Pulls the useful text out of a Nest error body. */
function describe(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;

  const { message, code } = body as { message?: unknown; code?: unknown };

  if (Array.isArray(message)) {
    return message.filter((m): m is string => typeof m === 'string').join('; ');
  }
  if (typeof message === 'string') {
    return typeof code === 'string' ? `${code}: ${message}` : message;
  }
  return undefined;
}
