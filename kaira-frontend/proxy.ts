import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route guard (Next.js 16 "proxy", formerly middleware). It only checks that an access
 * cookie is present; the authoritative check is the server-side /auth/me call in the app layout.
 * Without an access cookie the user goes to /login, which first tries a silent refresh.
 *
 * Runs before matched requests (Node.js runtime by default in Next 16). It does not call the backend and
 * does not validate the cookie's value; an expired or forged cookie passes here and is rejected by
 * getServerSession() in app/(app)/layout.tsx.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Backend proxy calls: only reject malformed percent-encoding here. Next decodes catch-all params before
  // the route handler runs and answers a bad escape (e.g. "%E0%A4%A") with a bare HTTP 500; this returns the
  // usual error envelope with 400 instead. Authentication for API calls is the backend's job (401 envelope),
  // so there is no login redirect on this branch.
  if (pathname.startsWith("/api/backend/")) {
    try {
      for (const segment of pathname.split("/")) decodeURIComponent(segment);
    } catch {
      return NextResponse.json(
        { success: false, data: null, error: { code: "BAD_REQUEST_PATH", message: "The request path is not valid URL encoding.", details: null } },
        { status: 400 },
      );
    }
    return NextResponse.next();
  }
  if (!request.cookies.has("kaira_access")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // resume=1 tells the login form to attempt POST /auth/refresh (the refresh cookie may still be valid)
    // before showing the form; `next` is sanitised on the login page (safeNext) before it is used.
    url.search = `?next=${encodeURIComponent(pathname + search)}&resume=1`;
    return NextResponse.redirect(url);
  }
  // Lets the server layout send the user back to this page if the session has to be resumed.
  const headers = new Headers(request.headers);
  headers.set("x-kaira-path", pathname + search);
  return NextResponse.next({ request: { headers } });
}

// Only the authenticated app sections are guarded; /login, static assets and /api/backend/* (which the
// backend protects itself) are not matched.
export const config = {
  matcher: [
    "/api/backend/:path*",
    "/agent/:path*",
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
