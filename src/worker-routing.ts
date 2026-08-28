import { isConceptPath, isolateConceptResponse } from "./concept-isolation";

export function createFetchHandler<RequestType extends Request, Environment, Context>(
  astroHandler: (request: RequestType, env: Environment, context: Context) => Promise<Response>,
) {
  return async (request: RequestType, env: Environment, context: Context): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    const response = await astroHandler(request, env, context);
    return isConceptPath(new URL(request.url).pathname)
      ? isolateConceptResponse(response)
      : response;
  };
}
