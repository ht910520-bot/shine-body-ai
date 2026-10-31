import { authorizeRequest } from "./lib/accessGate.js";

export default async function middleware(request: Request) {
  return authorizeRequest(request, process.env.APP_ACCESS_CODE || "") ?? undefined;
}

export const config = {
  matcher: "/:path*"
};
