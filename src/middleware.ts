import type { MiddlewareHandler } from "astro";
import { isConceptPath, isolateConceptResponse } from "./concept-isolation";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();
  return isConceptPath(context.url.pathname) ? isolateConceptResponse(response) : response;
};
