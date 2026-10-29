import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Body, Catch, Controller, Get, Headers, HttpCode, HttpException, Inject, Injectable, Module,
  Param, Post, Query, Res, UseGuards, type ArgumentsHost, type CanActivate, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { Counter, Histogram } from 'prom-client';
import { ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { WageringStore } from '../infrastructure/database/wagering-store';
import { Queries } from '../infrastructure/database/queries';
import { DomainError } from '../domain/errors';
import { identifier, ledgerQuery, openWalletInput, uuid, wagerInput } from './validation';
import { Telemetry } from '../observability';

// Explicit extension point for a future OIDC provider identity integration.
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean { return true; }
}

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

@Catch()
class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    if (error instanceof ZodError) { status = 400; code = 'INVALID_PAYLOAD'; }
    else if (error instanceof DomainError) {
      code = error.code;
      status = code.endsWith('_NOT_FOUND') ? 404 : code.endsWith('_CONFLICT') ? 409 : 400;
    } else if (error instanceof HttpException) {
      status = error.getStatus(); code = status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST';
    } else {
      const failure = error as { code?: string; cause?: { code?: string } };
      const sqlCode = failure?.code ?? failure?.cause?.code;
      if (sqlCode && (/^08/.test(sqlCode) || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','57014','53300','55P03','40P01','40001'].includes(sqlCode))) {
        status = 503; code = 'INFRASTRUCTURE_UNAVAILABLE';
      }
      log({ level: 'error', event: 'http_failure', correlationId: response.locals.correlationId, code });
    }
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json({ code, correlationId: response.locals.correlationId });
  }
}

export async function createApp(orm: MikroORM, options: { sqsEndpoint?: string; telemetry?: Telemetry } = {}) {
  const telemetry = options.telemetry ?? new Telemetry();
  const store = new WageringStore(orm, telemetry);
  const queries = new Queries(orm);
  const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: options.sqsEndpoint ?? process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' }, maxAttempts: 1 });
  const registry = telemetry.registry;
  const mismatches = new Counter({ name: 'wallet_reconciliation_mismatches_total', help: 'Reconciliation divergences', registers: [registry] });
  const outcomes = new Counter({ name: 'wager_http_transactions_total', help: 'Transaction responses', labelNames: ['status'], registers: [registry] });
  const duplicates = new Counter({ name: 'wager_http_duplicates_total', help: 'Idempotent replays', registers: [registry] });
  const latency = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['method','status'], registers: [registry] });

  @Controller()
  @UseGuards(ProviderIdentityGuard)
  class ApiController {
    constructor(@Inject(WageringStore) private readonly service: WageringStore) {}

    @Post('wallets')
    open(@Body() body: unknown) {
      const input = openWalletInput.parse(body);
      return this.service.openWallet(input.playerId, input.initialBalance);
    }

    @Get('wallets/:walletId')
    wallet(@Param('walletId') walletId: string) { return queries.wallet(uuid.parse(walletId)); }

    @Get('wallets/:walletId/ledger')
    ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
      const input = ledgerQuery.parse(query);
      return queries.ledger(uuid.parse(walletId), input.limit, input.cursor);
    }

    @Post('wallets/:walletId/reconciliation')
    @HttpCode(200)
    async reconcile(@Param('walletId') walletId: string, @Res({ passthrough: true }) response: Response) {
      const result = await queries.reconciliation(uuid.parse(walletId));
      if (!result.consistent) {
        mismatches.inc();
        log({ level: 'error', event: 'reconciliation_mismatch', walletId, correlationId: response.locals.correlationId });
      }
      return result;
    }

    @Post('wagering/transactions')
    async submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown, @Res({ passthrough: true }) response: Response) {
      const input = wagerInput.parse(body);
      const result = await this.service.submit(input, identifier.parse(key), { correlationId: response.locals.correlationId });
      response.status(result.status === 'PENDING_REFERENCE' || result.status === 'PENDING' ? 202 : result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 500 : 200);
      outcomes.inc({ status: result.status });
      if (result.idempotentReplay) duplicates.inc();
      log({ level: 'info', event: 'wager_response', correlationId: response.locals.correlationId,
        messageId: null, transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId,
        status: result.status, idempotentReplay: result.idempotentReplay });
      return result;
    }

    @Get('wagering/transactions/:id')
    transaction(@Param('id') id: string) { return queries.transaction(uuid.parse(id)); }

    @Get('providers/:providerId/wagering/transactions/:externalId')
    providerTransaction(@Param('providerId') providerId: string, @Param('externalId') externalId: string) {
      return queries.transaction({ providerId: identifier.parse(providerId), externalId: identifier.parse(externalId) });
    }

    @Get('health/live')
    live() { return { status: 'alive' }; }

    @Get('health/ready')
    async ready(@Res({ passthrough: true }) response: Response) {
      const checks = await Promise.allSettled([
        orm.em.getConnection().execute('SELECT 1'),
        sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }), { abortSignal: AbortSignal.timeout(2500) }),
      ]);
      const ready = checks.every(check => check.status === 'fulfilled');
      response.status(ready ? 200 : 503);
      return { status: ready ? 'ready' : 'unavailable', postgres: checks[0]?.status === 'fulfilled', sqs: checks[1]?.status === 'fulfilled' };
    }

    @Get('metrics')
    async metrics(@Res() response: Response) { response.type(registry.contentType).send(await registry.metrics()); }
  }

  @Module({ controllers: [ApiController], providers: [ProviderIdentityGuard, { provide: WageringStore, useValue: store }] })
  class ApiModule {}
  const app = await NestFactory.create(ApiModule, { logger: false });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header('x-correlation-id');
    response.locals.correlationId = incoming && /^[\w:-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    response.setHeader('X-Correlation-Id', response.locals.correlationId);
    const end = latency.startTimer();
    response.on('finish', () => end({ method: request.method, status: response.statusCode }));
    next();
  });
  app.useGlobalFilters(new ApiErrorFilter());
  await app.init();
  return { app, dispose: () => sqs.destroy() };
}
