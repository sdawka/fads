export function createFetchHandler<RequestType extends Request, Environment, Context>(
  astroHandler: (request: RequestType, env: Environment, context: Context) => Promise<Response>,
) {
  return async (request: RequestType, env: Environment, context: Context): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    return astroHandler(request, env, context);
  };
}
