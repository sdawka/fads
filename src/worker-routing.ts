import { isConceptPath, isolateConceptResponse } from "./concept-isolation";

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
      return Response.json({ status: "ok" });
    }

    const runtimeResponse = await runtimeHandler?.(request, env, context);
    if (runtimeResponse) return runtimeResponse;

    const response = await astroHandler(request, env, context);
    return isConceptPath(new URL(request.url).pathname)
      ? isolateConceptResponse(response)
      : response;
  };
}
