import { isConceptPath, isolateConceptResponse } from "./concept-isolation";

const APPLICATION_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'none'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join("; ");

function withBrowserSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("content-security-policy"))
    headers.set("content-security-policy", APPLICATION_CSP);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createFetchHandler<RequestType extends Request, Environment, Context>(
  astroHandler: (request: RequestType, env: Environment, context: Context) => Promise<Response>,
  runtimeHandler?: (
    request: RequestType,
    env: Environment,
    context: Context,
  ) => Promise<Response | undefined>,
) {
  return async (request: RequestType, env: Environment, context: Context): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/health") {
      return withBrowserSecurityHeaders(Response.json({ status: "ok" }));
    }

    const runtimeResponse = await runtimeHandler?.(request, env, context);
    if (runtimeResponse) return withBrowserSecurityHeaders(runtimeResponse);

    const response = await astroHandler(request, env, context);
    return withBrowserSecurityHeaders(
      isConceptPath(new URL(request.url).pathname) ? isolateConceptResponse(response) : response,
    );
  };
}
