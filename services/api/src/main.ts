import 'reflect-metadata';
import { join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { AppConfig } from './common/config';
import { MediaGateway } from './media/media.gateway';
import { BRAND_NAME } from '@examguard/config';

async function bootstrap(): Promise<void> {
  // Load .env from services/api or the repo root (dev convenience).
  dotenvConfig({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')] });

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(AppConfig);

  app.use(helmet());
  app.use(compression());
  app.enableCors({
    origin: config.env.CORS_ORIGINS,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const port = config.env.API_PORT;
  await app.listen(port);

  // Authenticated media-control WebSocket gateway (Phase 4A control plane).
  const gateway = app.get(MediaGateway);
  gateway.attach(app.getHttpServer());

  console.log(`${BRAND_NAME} API listening on http://localhost:${port} (env=${config.env.APP_ENV})`);
  console.log(`${BRAND_NAME} media gateway: ws://localhost:${port}${gateway.path}`);
}

void bootstrap();