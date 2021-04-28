import * as stream from 'stream';

export async function readStream(strm: stream.Readable): Promise<Buffer> {
  return new Promise((ok, ko) => {
    const data = new Array<Buffer>();

    strm.on('data', (chunk) => {
      data.push(chunk);
    });

    strm.on('end', () => {
      ok(Buffer.concat(data));
    });

    strm.on('error', (err) => {
      ko(err);
    });
  });
}

export function s3BodyToStream(body: stream.Readable | ReadableStream | Blob): stream.Readable {
  if (body instanceof stream.Readable) {
    return body;
  }

  throw new Error(`S3 response body is of unexpected type: ${body}`);
}