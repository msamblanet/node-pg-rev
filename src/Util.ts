import Stream from 'pg-query-stream';
import pg from 'pg';

export async function * emptyAsyncGenerator<X>(): AsyncGenerator<X> {} // eslint-disable-line @typescript-eslint/no-empty-function
export const emptyAsync = emptyAsyncGenerator<any>();

export async function * limitAsyncIterable<X>(items: AsyncIterable<X>, limit: number): AsyncGenerator<X> {
  if (limit >= 1) {
    for await (const item of items) {
      yield item;
      limit--;
      if (limit < 1) {
        break;
      }
    }
  }
}

export async function poolStream<X extends Stream>(pool: pg.Pool, query: X): Promise<X> {
  // Function to workaround https://github.com/brianc/node-pg-query-stream/issues/28
  const client = await pool.connect();
  try {
    const stream = client.query(query);
    stream.on('end', client.release);
    return stream;
  } catch (error: unknown) {
    client.release();
    throw error;
  }
}
