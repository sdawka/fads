/** A read-only probe. It never logs configuration, credentials or private content. */
export async function checkReadiness(checks: {
  validateConfig: () => void;
  checkDatabase: () => Promise<void>;
  checkSessions: () => Promise<void>;
}): Promise<boolean> {
  try {
    checks.validateConfig();
    await checks.checkDatabase();
    await checks.checkSessions();
    return true;
  } catch {
    return false;
  }
}
