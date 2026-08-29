import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { type Env } from './config/env.schema.js';
import { requestLogger } from './common/middleware/request-logger.middleware.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);

  const port = config.get('PORT', { infer: true });
  const apiPrefix = config.get('API_PREFIX', { infer: true });
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true });

  // `/health` stays unprefixed so probes hit exactly GET /health.
  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });

  // Log every request with status and duration. Registered as middleware, not
  // an interceptor, so that unmatched routes (404s) are logged too — a client
  // calling the wrong path is otherwise invisible from the server side.
  app.use(requestLogger);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties, and reject rather than ignore them: a request
      // carrying a field the server does not recognise is a request the client
      // and server disagree about, which is not a thing to be lenient over in a
      // money API.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((value) => value.trim()),
    credentials: true,
  });

  // Run onModuleDestroy hooks (closing the Postgres and Redis connections) on
  // SIGTERM, so a rolling deploy drains instead of dropping in-flight work.
  app.enableShutdownHooks();

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API listening on port ${port} (prefix: /${apiPrefix}, health: /health)`);
}

void bootstrap();
