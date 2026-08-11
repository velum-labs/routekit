const METADATA = "http://169.254.169.254/latest";

export async function metadataToken(): Promise<string> {
  const response = await fetch(`${METADATA}/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`IMDS token returned HTTP ${response.status}`);
  return await response.text();
}

export async function metadata(path: string, token: string): Promise<string> {
  const response = await fetch(`${METADATA}/${path}`, {
    headers: { "x-aws-ec2-metadata-token": token },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`IMDS ${path} returned HTTP ${response.status}`);
  return await response.text();
}
