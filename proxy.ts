import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route guard (Next.js 16 "proxy", formerly middleware). It only checks that an access
 * cookie is present; the authoritative check is the server-side /auth/me call in the app layout.
 * Without an access cookie the user goes to /login, which first tries a silent refresh.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!request.cookies.has("kaira_access")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}&resume=1`;
    return NextResponse.redirect(url);
  }
  // Lets the server layout send the user back to this page if the session has to be resumed.
  const headers = new Headers(request.headers);
  headers.set("x-kaira-path", pathname + search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/customers/:path*",
    "/invoices/:path*",
    "/receivables/:path*",
    "/cashflow/:path*",
    "/scenarios/:path*",
    "/actions/:path*",
    "/settings/:path*",
  ],
};
