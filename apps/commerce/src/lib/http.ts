/**
 * `JSON.stringify` throws on bigint, and every money value in this system is a
 * bigint. Serialise them as strings so no amount is ever silently pushed
 * through a float on its way to the client.
 */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  return new Response(body, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
