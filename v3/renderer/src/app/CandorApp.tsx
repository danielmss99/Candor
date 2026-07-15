import { AppProviders } from "./AppProviders";
import { CandorWorkspace } from "./CandorWorkspace";
import { useAppearance } from "../features/appearance/useAppearance";

export function CandorApp() {
  useAppearance();
  return (
    <AppProviders>
      <CandorWorkspace />
    </AppProviders>
  );
}

export default CandorApp;

