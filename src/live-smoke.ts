export function assertCleanSuccessfulSmoke(status: string, porcelainStatus: string): void {
  if (status !== "finished") throw new Error(`Cursor smoke run failed with status: ${status}`);
  if (porcelainStatus.trim()) throw new Error("Cursor smoke run modified the disposable repository");
}
