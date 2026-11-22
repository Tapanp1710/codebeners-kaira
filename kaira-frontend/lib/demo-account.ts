/**
 * The public evaluator account shown on the sign-in page ("Try KAIRA Demo").
 *
 * These credentials are PUBLIC on purpose: hackathon evaluators sign in without registering. The account is
 * the owner of the seeded demo business only (created by `python -m app.cli seed --force`); every API call is
 * scoped to the caller's business on the backend, so it cannot see other businesses or users. It is a
 * dedicated password, not shared with any other account, key or secret.
 *
 * Rotation: change the backend password for this account first, then update `password` here and redeploy the
 * frontend. Set DEMO_ACCOUNT to null to hide the section; the page never shows placeholder credentials.
 */
export type DemoAccount = { email: string; password: string };

export const DEMO_ACCOUNT: DemoAccount | null = {
  email: "demo@kaira.local",
  password: "KairaDemo-DJVfPpiK",
};
