export type DecodedJsonBody = {
  body: unknown;
  hasJsonBody: boolean;
};

export async function decodeJsonBody(response: Response): Promise<DecodedJsonBody> {
  try {
    return { body: await response.json(), hasJsonBody: true };
  } catch {
    return { body: undefined, hasJsonBody: false };
  }
}
