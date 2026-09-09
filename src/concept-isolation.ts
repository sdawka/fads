export const conceptIsolationPolicy =
  "sandbox allow-scripts; base-uri 'none'; object-src 'none'; frame-ancestors 'self'";

export function isConceptPath(pathname: string): boolean {
  return pathname === "/concept" || pathname.startsWith("/concept/");
}

export function isolateConceptResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", conceptIsolationPolicy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
