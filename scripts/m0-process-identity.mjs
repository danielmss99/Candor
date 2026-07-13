export function isCandorProcessName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized === "candor" ||
    normalized === "candor-core" ||
    normalized.startsWith("candor helper")
  );
}
