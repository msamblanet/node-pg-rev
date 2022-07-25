import * as NodeStream from 'node:stream';
import { Readable, Stream, Duplex } from 'node:stream';
import batch from 'it-batch';
import QueryStream from 'pg-query-stream';
import pg from 'pg';

// @todo remove this temporary hack
// the current Node typescript defs do not include compose which is VERY useful
export const compose = (NodeStream as any).compose as (...streams: Array<Stream | Iterable<unknown> | AsyncIterable<unknown> | ((...args: any) => any)>) => Duplex;

export async function poolStream<X extends QueryStream>(pool: pg.Pool, stream: X): Promise<X> {
  // Function to workaround https://github.com/brianc/node-pg-query-stream/issues/28
  const client = await pool.connect();
  try {
    stream = client.query(stream);
    stream.on('close', () => {
      client.release();
    });
    return stream;
  } catch (error: unknown) {
    stream.destroy();
    client.release();
    throw error;
  }
}

export async function poolStreamQuery(pool: pg.Pool, text: string, values?: any[], config?: ConstructorParameters<typeof QueryStream>[2]): Promise<QueryStream> {
  return poolStream(pool, new QueryStream(text, values, config));
}

export async function withStream<X>(stream: Readable, cb: (stream: Readable) => Promise<X>): Promise<X> {
  try {
    return await cb(stream);
  } finally {
    stream.destroy();
  }
}

export function limitStream<X>(limit: number): (source: AsyncIterable<X>) => AsyncIterable<X> {
  async function * generator(source: AsyncIterable<X>) {
    if (limit >= 1) {
      for await (const item of source) {
        yield item;
        limit--;
        if (limit < 1) {
          break;
        }
      }
    }
  }

  return generator;
}

export function batchStream<X>(batchSize: number): (source: AsyncIterable<X>) => AsyncIterable<X[]> {
  async function * generator(source: AsyncIterable<X>) {
    for await (const item of batch(source, batchSize)) {
      yield item;
    }
  }

  return generator;
}
