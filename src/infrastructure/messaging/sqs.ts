import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export function createSqs(endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566'): SQSClient {
  return new SQSClient({ endpoint, useQueueUrlAsEndpoint: false, region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 1,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 6000 },
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const result = await sqs.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: AbortSignal.timeout(5000) });
  if (!result.QueueUrl) throw new Error('Queue URL is missing');
  return result.QueueUrl;
}
