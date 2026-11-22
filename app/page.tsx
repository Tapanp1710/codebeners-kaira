/**
 * `/` has no content of its own. redirect() in a Server Component throws NEXT_REDIRECT and answers with a
 * temporary (307) redirect to /agent, the KAIRA
 * agent home. `/` is not in proxy.ts's matcher, so an unauthenticated visitor is
 * caught one hop later: proxy.ts (no cookie) or the (app) layout's /auth/me check sends them to /login.
 */
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/agent");
}
